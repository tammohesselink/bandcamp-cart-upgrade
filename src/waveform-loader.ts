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

// A track whose audio couldn't be downloaded is tried again when it next plays
// after this long.
export const WAVEFORM_RETRY_AFTER_MS = 60 * 1000;

// A decode that hasn't finished by then counts as failed, so it can't hold up
// every later load.
export const WAVEFORM_DECODE_TIMEOUT_MS = 2 * 60 * 1000;

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface WaveformJob {
  track: PlaylistTrack;
  key: string;
  // Loaded ahead for an upcoming track rather than for the one playing.
  prefetch: boolean;
}

interface RunningLoad {
  job: WaveformJob;
  controller: AbortController;
  // Decoding a whole track takes a lot of memory and can't be stopped. A
  // newer request lets it finish and keeps its waveform; turning waveforms
  // off stops it, and the next load still waits for it.
  decoding: boolean;
}

// Gets the waveform of the track that is playing: from storage when it was
// drawn before, otherwise by downloading and decoding the track. Only one
// track loads at a time: asking for another stops the download of the one
// before, so skipping through a playlist doesn't download every track. Once
// the playing track's waveform is in, the waveforms of the next few tracks
// load one by one (see prefetch), so they show as soon as those tracks start.
export class WaveformLoader {
  private waveforms = new Map<string, Waveform>();
  private status = new Map<string, WaveformStatus>();
  private retryAt = new Map<string, number>();
  // Tracks whose last failure was while loading ahead. Playing one tries it
  // again straight away, as a download the user is waiting on.
  private failedAhead = new Set<string>();
  // The playing track, which loads before any upcoming one.
  private waiting: WaveformJob | null = null;
  // The track asked for last, i.e. the playing one.
  private playingKey: string | null = null;
  // Upcoming tracks, loaded in order once nothing else is.
  private prefetchQueue: WaveformJob[] = [];
  // The load that is running, which a newer request stops.
  private running: RunningLoad | null = null;
  private listeners = new Set<() => void>();
  private enabled = false;

  constructor(private deps: WaveformLoaderDeps) {}

  // Whether "Show a waveform" is on. While off, nothing is downloaded and the
  // player shows its plain seek bar.
  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.waiting = null;
      this.playingKey = null;
      this.prefetchQueue = [];
      this.stopRunning();
    }
    // Statuses left by a run that was turned off, or a refused permission.
    for (const [key, status] of this.status) if (status === 'loading' || status === 'unavailable') this.status.delete(key);
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

  // Whether the track's waveform still needs loading: it isn't known, on its
  // way, impossible to get, or failed a moment ago. A failure while loading
  // ahead doesn't hold back the playing track.
  private needsLoad(track: PlaylistTrack, key: string, prefetch: boolean): boolean {
    if (track.unplayable || this.waveforms.has(key)) return false;
    const status = this.status.get(key);
    if (status === 'loading' || status === 'unavailable') return false;
    if (status !== 'error') return true;
    if (!prefetch && this.failedAhead.has(key)) return true;
    return Date.now() >= (this.retryAt.get(key) ?? 0);
  }

  // Gets the playing track's waveform unless it is already known or on its way.
  request(track: PlaylistTrack): void {
    if (!this.enabled) return;
    const key = trackWaveformKey(track);
    // Asked for again, e.g. to retry it, rather than a different track
    // starting to play.
    const again = key === this.playingKey;
    this.playingKey = key;
    // Already loading ahead: it's the playing track's load now, so the steps
    // it hasn't reached yet aren't bulk, and a later prefetch doesn't stop it.
    if (this.running?.job.key === key) this.running.job.prefetch = false;
    if (!this.needsLoad(track, key, false)) return;
    // The track asked for before isn't wanted any more. A load still
    // downloading stops: the playing track goes first. When the same track is
    // asked for again, an upcoming track's load goes back in the queue; when
    // another track starts, the queue empties and the player sends what is
    // upcoming from there.
    if (this.waiting && this.waiting.key !== key) this.status.delete(this.waiting.key);
    if (this.running && this.running.job.key !== key && !this.running.decoding) {
      const stopped = this.running.job;
      if (this.stopRunning() && stopped.prefetch && again) this.prefetchQueue.unshift(stopped);
    }
    this.prefetchQueue = again ? this.prefetchQueue.filter((job) => job.key !== key) : [];
    this.waiting = { track, key, prefetch: false };
    this.status.set(key, 'loading');
    this.notify();
    this.startNext();
  }

  // Loads the waveforms of the tracks that play next, in order, after the
  // playing track's. Replaces the tracks asked for before, and stops the
  // download of one that is no longer among them.
  prefetch(tracks: PlaylistTrack[]): void {
    if (!this.enabled) return;
    const keys = tracks.map((track) => trackWaveformKey(track));
    const running = this.running;
    if (running?.job.prefetch && !running.decoding && !keys.includes(running.job.key)) this.stopRunning();
    this.prefetchQueue = [];
    tracks.forEach((track, i) => {
      const key = keys[i]!;
      if (this.prefetchQueue.some((job) => job.key === key)) return;
      if (this.needsLoad(track, key, true)) this.prefetchQueue.push({ track, key, prefetch: true });
    });
    this.startNext();
  }

  // Stops the running load. Its status goes at once rather than when the run
  // notices, so the track can be asked for again straight away. Returns
  // whether it was still loading: a load that has just finished keeps the
  // status it ended with (e.g. 'error' and its wait before a retry).
  private stopRunning(): boolean {
    if (!this.running) return false;
    const { job, controller } = this.running;
    controller.abort();
    if (this.status.get(job.key) !== 'loading') return false;
    this.status.delete(job.key);
    return true;
  }

  private startNext(): void {
    if (this.running && (!this.running.controller.signal.aborted || this.running.decoding)) return;
    const job = this.waiting ?? this.prefetchQueue.shift();
    if (!job) return;
    this.waiting = null;
    const controller = new AbortController();
    // Set before notifying, so a listener asking for a track sees this load.
    const running: RunningLoad = { job, controller, decoding: false };
    this.running = running;
    if (job.prefetch) {
      this.status.set(job.key, 'loading');
      this.notify();
    }
    void this.run(running).finally(() => {
      if (this.running !== running) return;
      this.running = null;
      this.startNext();
    });
  }

  private async run(running: RunningLoad): Promise<void> {
    const { job, controller: { signal } } = running;
    const { track, key } = job;
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
      // Read when each step starts: the job stops being a load-ahead once its
      // track plays.
      if (!isStreamFresh(track)) await untilAborted(this.deps.refreshStream(track, job.prefetch), signal);
      check();
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await untilAborted(this.deps.fetchAudio(track.streamUrl, signal, job.prefetch), signal);
      check();
      if (response.noPermission) {
        this.status.set(key, 'unavailable');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      running.decoding = true;
      let channels: Float32Array[];
      try {
        channels = await withTimeout(this.deps.decode(base64ToBytes(response.audioBase64)), WAVEFORM_DECODE_TIMEOUT_MS);
      } finally {
        running.decoding = false;
      }
      check();
      const waveform = computeWaveform(channels, WAVEFORM_SAMPLE_RATE);
      if (!(waveform.seconds > 0)) throw new Error('The audio decoded to nothing');
      this.waveforms.set(key, waveform);
      this.status.delete(key);
      this.retryAt.delete(key);
      this.failedAhead.delete(key);
      this.deps.write(key, waveform);
    } catch (err) {
      // Stopped by a newer request or turning waveforms off: stopRunning has
      // already cleared its status.
      if (err instanceof Superseded || signal.aborted) return;
      log.warn('[bcp] Could not get the audio for the waveform of', track.trackTitle, err);
      this.status.set(key, 'error');
      this.retryAt.set(key, Date.now() + WAVEFORM_RETRY_AFTER_MS);
      if (job.prefetch) this.failedAhead.add(key);
      else this.failedAhead.delete(key);
    } finally {
      this.notify();
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
