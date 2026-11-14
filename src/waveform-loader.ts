import type { PlaylistTrack } from './types';
import type { FetchAudioResponse } from './messages';
import { sendBcpMessage } from './messages';
import { base64ToBytes } from './audio-fetch';
import { isStreamFresh } from './cache';
import { decodeAudioChannels } from './audio-decode';
import { trackStorageId } from './tempo-store';
import {
  WAVEFORM_SAMPLE_RATE,
  computeWaveform,
  decodeWaveform,
  encodeWaveform,
  type StoredWaveform,
  type Waveform,
} from './waveform';
import { log } from './log';

// Waveforms, one entry per track. A track's audio never changes, so entries
// don't expire.
export const WAVEFORM_KEY_PREFIX = 'bcp_waveform_v1_';

export function trackWaveformKey(track: Pick<PlaylistTrack, 'trackId' | 'pageUrl' | 'trackTitle'>): string {
  return `${WAVEFORM_KEY_PREFIX}${trackStorageId(track)}`;
}

// 'loading': the audio is downloading or being decoded.
// 'error': the audio couldn't be downloaded or decoded; retried after a while.
// 'unavailable': there is no waveform to get (the track can't be streamed, or
// the permission to read streams was taken away).
export type WaveformStatus = 'none' | 'loading' | 'ready' | 'error' | 'unavailable';

export interface TrackWaveform {
  status: WaveformStatus;
  waveform: Waveform | null;
}

export interface WaveformLoaderDeps {
  // Gives the track a fresh stream link (see Player.onRefreshStream). `bulk`
  // queues the fetch behind ones the user is waiting on.
  refreshStream: (track: PlaylistTrack, bulk: boolean) => Promise<void>;
  // Downloads the whole track (or as much of a long one as is allowed), and
  // stops the download when `signal` aborts. `bulk` queues the download behind
  // ones the user is waiting on.
  fetchAudio: (url: string, signal: AbortSignal, bulk: boolean) => Promise<FetchAudioResponse>;
  // Decodes audio file bytes to samples per channel at WAVEFORM_SAMPLE_RATE.
  decode: (bytes: Uint8Array) => Promise<Float32Array[]>;
  read: (key: string) => Promise<Waveform | null>;
  write: (key: string, waveform: Waveform) => void;
}

// A track whose audio couldn't be downloaded is tried again after this long.
export const WAVEFORM_RETRY_AFTER_MS = 60 * 1000;

// A decode that hasn't finished by then counts as failed, so a decode that
// never settles can't hold up every later load. The decode itself can't be
// stopped, so this is long enough that only a stuck one reaches it.
export const WAVEFORM_DECODE_TIMEOUT_MS = 5 * 60 * 1000;

class Superseded extends Error {}

// Settles like `promise`, or throws Superseded as soon as `signal` aborts. A
// stopped download may only answer once the background gets to it, and the
// next load shouldn't wait for that.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Superseded());
    // Handled even when already stopped, so a later failure isn't unhandled.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface RunningLoad {
  track: PlaylistTrack;
  key: string;
  // Loaded ahead for an upcoming track rather than for the one playing. Read
  // when each step starts, so the steps after its track starts playing aren't
  // bulk.
  prefetch: boolean;
  controller: AbortController;
  // Decoding a whole track takes a lot of memory and can't be stopped, so a
  // decoding load is never stopped: it finishes and its waveform is kept.
  decoding: boolean;
}

// Gets the waveform of the track that is playing: from storage when it was
// drawn before, otherwise by downloading and decoding the track. Once that is
// in, the waveforms of the next few tracks load (see prefetch), so they show
// as soon as those tracks start.
//
// The player says which track plays (setPlaying) and which come next
// (prefetch); schedule() works out what to load from that. Only one track
// loads at a time, and a download nobody wants any more stops, so skipping
// through a playlist doesn't download every track.
export class WaveformLoader {
  private waveforms = new Map<string, Waveform>();
  private status = new Map<string, WaveformStatus>();
  private retryAt = new Map<string, number>();
  // Tracks whose last failure was while loading ahead. Playing one tries it
  // again straight away, as a download the user is waiting on.
  private failedAhead = new Set<string>();
  private playing: PlaylistTrack | null = null;
  private upcoming: PlaylistTrack[] = [];
  private running: RunningLoad | null = null;
  private listeners = new Set<() => void>();
  private enabled = false;

  constructor(private deps: WaveformLoaderDeps) {}

  // Whether "Show a waveform" is on. While off, nothing is downloaded and the
  // player shows its plain seek bar.
  get isEnabled(): boolean {
    return this.enabled;
  }

  // Turned on while a track plays, its waveform and the next ones load now
  // rather than at the next track.
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    // Retry what a refused permission made unavailable.
    for (const [key, status] of this.status) if (status === 'unavailable') this.status.delete(key);
    this.schedule();
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(track: PlaylistTrack): TrackWaveform {
    const key = trackWaveformKey(track);
    const waveform = this.waveforms.get(key) ?? null;
    if (waveform) return { status: 'ready', waveform };
    const status = this.status.get(key) ?? (track.unplayable ? 'unavailable' : 'none');
    return { status, waveform: null };
  }

  // Shows a waveform drawn before without downloading anything, e.g. for a
  // track that is cued but not playing yet.
  async loadStored(track: PlaylistTrack): Promise<void> {
    if (!this.enabled) return;
    const key = trackWaveformKey(track);
    if (this.waveforms.has(key)) return;
    const stored = await this.deps.read(key);
    if (!stored || this.waveforms.has(key)) return;
    this.waveforms.set(key, stored);
    this.notify();
  }

  // The track that started playing, called each time it does. Its waveform
  // loads before any upcoming one, and a failed one is tried again once its
  // wait is over. Another track playing empties the tracks to load ahead
  // until the player sends the ones that follow it.
  setPlaying(track: PlaylistTrack): void {
    if (!this.playing || trackWaveformKey(this.playing) !== trackWaveformKey(track)) this.upcoming = [];
    this.playing = track;
    this.schedule();
  }

  // The tracks that play next, in order, to load after the playing track.
  // Replaces the tracks sent before; the download of one no longer among
  // them stops.
  prefetch(tracks: PlaylistTrack[]): void {
    this.upcoming = tracks;
    this.schedule();
  }

  // Whether the track's waveform still needs loading: it isn't known,
  // impossible to get, or failed a moment ago. A failure while loading ahead
  // doesn't hold back the playing track.
  private needsLoad(track: PlaylistTrack, prefetch: boolean): boolean {
    const key = trackWaveformKey(track);
    if (track.unplayable || this.waveforms.has(key)) return false;
    const status = this.status.get(key);
    if (status === 'unavailable') return false;
    if (status !== 'error') return true;
    if (!prefetch && this.failedAhead.has(key)) return true;
    return Date.now() >= (this.retryAt.get(key) ?? 0);
  }

  // What to load, in order: the playing track, then the upcoming ones.
  private wanted(): { track: PlaylistTrack; prefetch: boolean }[] {
    if (!this.enabled) return [];
    const wanted: { track: PlaylistTrack; prefetch: boolean }[] = [];
    const keys = new Set<string>();
    const add = (track: PlaylistTrack, prefetch: boolean) => {
      const key = trackWaveformKey(track);
      if (keys.has(key) || !this.needsLoad(track, prefetch)) return;
      keys.add(key);
      wanted.push({ track, prefetch });
    };
    if (this.playing) add(this.playing, false);
    for (const track of this.upcoming) add(track, true);
    return wanted;
  }

  // Brings what is loading in line with what is wanted: stops a download
  // that isn't wanted first any more, and starts the first wanted load once
  // nothing is running. Notifies only when that changed something, so a
  // listener may call setPlaying or prefetch.
  private schedule(): void {
    let changed = false;
    const wanted = this.wanted();
    const first = wanted[0];
    const firstKey = first && trackWaveformKey(first.track);
    const playingKey = this.playing && trackWaveformKey(this.playing);
    const running = this.running;
    if (running) {
      if (running.key === playingKey) running.prefetch = false;
      if (!running.decoding && running.key !== firstKey) {
        running.controller.abort();
        this.running = null;
        changed = true;
      }
    }
    // Only what is running, and the playing track waiting for its turn (which
    // shows its spinner meanwhile), is loading.
    const waitingKey = first && !first.prefetch ? firstKey : undefined;
    if (waitingKey && this.status.get(waitingKey) !== 'loading') {
      this.status.set(waitingKey, 'loading');
      changed = true;
    }
    for (const [key, status] of this.status) {
      if (status === 'loading' && key !== waitingKey && key !== this.running?.key) {
        this.status.delete(key);
        changed = true;
      }
    }
    if (this.running || !first) {
      if (changed) this.notify();
      return;
    }
    const load: RunningLoad = {
      track: first.track,
      key: trackWaveformKey(first.track),
      prefetch: first.prefetch,
      controller: new AbortController(),
      decoding: false,
    };
    this.running = load;
    this.status.set(load.key, 'loading');
    void this.run(load).finally(() => {
      if (this.running !== load) return;
      this.running = null;
      this.schedule();
      // What the load ended with.
      this.notify();
    });
    this.notify();
  }

  private async run(load: RunningLoad): Promise<void> {
    const { track, key, controller: { signal } } = load;
    const check = () => {
      if (signal.aborted) throw new Superseded();
    };
    try {
      const stored = await untilAborted(this.deps.read(key), signal);
      check();
      if (stored) {
        this.waveforms.set(key, stored);
        this.status.delete(key);
        return;
      }
      if (!isStreamFresh(track)) await untilAborted(this.deps.refreshStream(track, load.prefetch), signal);
      check();
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await untilAborted(this.deps.fetchAudio(track.streamUrl, signal, load.prefetch), signal);
      check();
      if (response.noPermission) {
        this.status.set(key, 'unavailable');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      // From here on the load is never stopped (see RunningLoad.decoding).
      load.decoding = true;
      const channels = await withTimeout(this.deps.decode(base64ToBytes(response.audioBase64)), WAVEFORM_DECODE_TIMEOUT_MS);
      const waveform = computeWaveform(channels, WAVEFORM_SAMPLE_RATE);
      if (!(waveform.seconds > 0)) throw new Error('The audio decoded to nothing');
      this.waveforms.set(key, waveform);
      this.status.delete(key);
      this.retryAt.delete(key);
      this.failedAhead.delete(key);
      this.deps.write(key, waveform);
    } catch (err) {
      // No longer wanted: schedule() has already cleared its status.
      if (err instanceof Superseded) return;
      log.warn('[bcp] Could not get the audio for the waveform of', track.trackTitle, err);
      this.status.set(key, 'error');
      this.retryAt.set(key, Date.now() + WAVEFORM_RETRY_AFTER_MS);
      if (load.prefetch) this.failedAhead.add(key);
      else this.failedAhead.delete(key);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

async function readWaveform(key: string): Promise<Waveform | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return decodeWaveform(result[key]);
  } catch {
    return null;
  }
}

function writeWaveform(key: string, waveform: Waveform): void {
  const stored: StoredWaveform = encodeWaveform(waveform);
  chrome.storage.local.set({ [key]: stored }).catch(() => {});
}

export function createWaveformLoader(refreshStream: WaveformLoaderDeps['refreshStream']): WaveformLoader {
  return new WaveformLoader({
    refreshStream,
    fetchAudio: (url, signal, bulk) => {
      const requestId = `waveform-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      signal.addEventListener('abort', () => void sendBcpMessage({ type: 'cancel-audio', requestId }).catch(() => {}), { once: true });
      return sendBcpMessage({ type: 'fetch-audio', url, whole: true, bulk, requestId });
    },
    decode: (bytes) => decodeAudioChannels(bytes, WAVEFORM_SAMPLE_RATE),
    read: readWaveform,
    write: writeWaveform,
  });
}
