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

class Superseded extends Error {}

interface WaveformJob {
  track: PlaylistTrack;
  key: string;
  // Loaded ahead for an upcoming track rather than for the one playing.
  prefetch: boolean;
}

// Gets the waveform of the track that is playing: from storage when it was
// drawn before, otherwise by downloading and decoding the track. Only one
// track loads at a time: asking for another stops the download of the one
// before, so skipping through a playlist doesn't download every track. Once
// the playing track's waveform is in, the next few tracks' load one by one
// (see prefetch), so their waveforms show as soon as they start.
export class WaveformLoader {
  private waveforms = new Map<string, Waveform>();
  private status = new Map<string, WaveformStatus>();
  private retryAt = new Map<string, number>();
  // The playing track, which loads before any upcoming one.
  private waiting: WaveformJob | null = null;
  // Upcoming tracks, loaded in order once nothing else is.
  private prefetchQueue: WaveformJob[] = [];
  // The load that is running, which a newer request stops.
  private running: { key: string; prefetch: boolean; controller: AbortController } | null = null;
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
      this.prefetchQueue = [];
      this.running?.controller.abort();
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
  // way, impossible to get, or failed a moment ago.
  private needsLoad(track: PlaylistTrack, key: string): boolean {
    if (track.unplayable || this.waveforms.has(key)) return false;
    const status = this.status.get(key);
    if (status === 'loading' || status === 'unavailable') return false;
    return !(status === 'error' && Date.now() < (this.retryAt.get(key) ?? 0));
  }

  // Gets the playing track's waveform unless it is already known or on its way.
  request(track: PlaylistTrack): void {
    if (!this.enabled) return;
    const key = trackWaveformKey(track);
    // Already loading ahead: it's the playing track's load now, which a later
    // prefetch doesn't stop.
    if (this.running?.key === key) this.running.prefetch = false;
    if (!this.needsLoad(track, key)) return;
    // The track asked for before isn't wanted any more, and neither is an
    // upcoming track's load: the playing track goes first.
    if (this.waiting && this.waiting.key !== key) this.status.delete(this.waiting.key);
    if (this.running && this.running.key !== key) this.running.controller.abort();
    this.prefetchQueue = this.prefetchQueue.filter((job) => job.key !== key);
    this.waiting = { track, key, prefetch: false };
    this.status.set(key, 'loading');
    this.notify();
    this.startNext();
  }

  // Loads the waveforms of the tracks that play next, in order, after the
  // playing track's. Replaces the tracks asked for before, and stops the load
  // of one that is no longer among them.
  prefetch(tracks: PlaylistTrack[]): void {
    if (!this.enabled) return;
    const jobs: WaveformJob[] = [];
    for (const track of tracks) {
      const key = trackWaveformKey(track);
      if (key === this.waiting?.key || jobs.some((job) => job.key === key)) continue;
      if (this.needsLoad(track, key)) jobs.push({ track, key, prefetch: true });
    }
    this.prefetchQueue = jobs;
    if (this.running?.prefetch) {
      const runningKey = this.running.key;
      if (!tracks.some((track) => trackWaveformKey(track) === runningKey)) this.running.controller.abort();
    }
    this.startNext();
  }

  private startNext(): void {
    if (this.running) return;
    const job = this.waiting ?? this.prefetchQueue.shift();
    if (!job) return;
    if (job === this.waiting) this.waiting = null;
    else {
      this.status.set(job.key, 'loading');
      this.notify();
    }
    const controller = new AbortController();
    this.running = { key: job.key, prefetch: job.prefetch, controller };
    void this.run(job, controller.signal).finally(() => {
      this.running = null;
      this.startNext();
    });
  }

  private async run({ track, key, prefetch }: WaveformJob, signal: AbortSignal): Promise<void> {
    const check = () => {
      if (signal.aborted) throw new Superseded();
    };
    try {
      const stored = await this.deps.read(key);
      check();
      if (stored) {
        this.waveforms.set(key, stored);
        this.status.delete(key);
        return;
      }
      if (!isStreamFresh(track)) await this.deps.refreshStream(track, prefetch);
      check();
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await this.deps.fetchAudio(track.streamUrl, signal, prefetch);
      check();
      if (response.noPermission) {
        this.status.set(key, 'unavailable');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      const channels = await this.deps.decode(base64ToBytes(response.audioBase64));
      check();
      const waveform = computeWaveform(channels, WAVEFORM_SAMPLE_RATE);
      if (!(waveform.seconds > 0)) throw new Error('The audio decoded to nothing');
      this.waveforms.set(key, waveform);
      this.status.delete(key);
      this.retryAt.delete(key);
      this.deps.write(key, waveform);
    } catch (err) {
      if (err instanceof Superseded) {
        // Stopped by a newer request or turning waveforms off: nothing to show.
        if (this.status.get(key) === 'loading' && this.waiting?.key !== key) this.status.delete(key);
        return;
      }
      log.warn('[bcp] Could not get the audio for the waveform of', track.trackTitle, err);
      this.status.set(key, 'error');
      this.retryAt.set(key, Date.now() + WAVEFORM_RETRY_AFTER_MS);
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
