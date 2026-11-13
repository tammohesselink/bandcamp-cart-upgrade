import type { PlaylistTrack } from './types';
import type { FetchAudioResponse } from './messages';
import { sendBcpMessage } from './messages';
import { base64ToBytes } from './audio-fetch';
import { isStreamFresh } from './cache';
import { mixToMono } from './tempo-analysis';
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
  // Gives the track a fresh stream link (see Player.onRefreshStream).
  refreshStream: (track: PlaylistTrack) => Promise<void>;
  // Downloads the whole track (or as much of a long one as is allowed).
  fetchAudio: (url: string) => Promise<FetchAudioResponse>;
  // Decodes audio file bytes to mono samples at WAVEFORM_SAMPLE_RATE.
  decode: (bytes: Uint8Array) => Promise<Float32Array>;
  read: (key: string) => Promise<Waveform | null>;
  write: (key: string, waveform: Waveform) => void;
}

// A track whose audio couldn't be downloaded is tried again when it next plays
// after this long.
export const WAVEFORM_RETRY_AFTER_MS = 60 * 1000;

class Superseded extends Error {}

// Gets the waveform of the track that is playing: from storage when it was
// drawn before, otherwise by downloading and decoding the track. Only one
// track loads at a time, and only the most recently asked-for one waits, so
// skipping through a playlist doesn't queue up a download per track.
export class WaveformLoader {
  private waveforms = new Map<string, Waveform>();
  private status = new Map<string, WaveformStatus>();
  private retryAt = new Map<string, number>();
  private waiting: { track: PlaylistTrack; key: string } | null = null;
  private running = false;
  private listeners = new Set<() => void>();
  private enabled = false;
  // Bumped when waveforms are turned off, so a load still running drops its result.
  private generation = 0;

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
      this.generation++;
      this.waiting = null;
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

  // Gets the track's waveform unless it is already known or on its way.
  request(track: PlaylistTrack): void {
    if (!this.enabled || track.unplayable) return;
    const key = trackWaveformKey(track);
    if (this.waveforms.has(key)) return;
    const status = this.status.get(key);
    if (status === 'loading' || status === 'unavailable') return;
    if (status === 'error' && Date.now() < (this.retryAt.get(key) ?? 0)) return;
    // The track asked for before, if it hasn't started, isn't wanted any more.
    if (this.waiting && this.waiting.key !== key) this.status.delete(this.waiting.key);
    this.waiting = { track, key };
    this.status.set(key, 'loading');
    this.notify();
    this.startNext();
  }

  private startNext(): void {
    if (this.running || !this.waiting) return;
    const job = this.waiting;
    this.waiting = null;
    this.running = true;
    void this.run(job.track, job.key).finally(() => {
      this.running = false;
      this.startNext();
    });
  }

  private async run(track: PlaylistTrack, key: string): Promise<void> {
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation) throw new Superseded();
    };
    try {
      const stored = await this.deps.read(key);
      check();
      if (stored) {
        this.waveforms.set(key, stored);
        this.status.delete(key);
        return;
      }
      if (!isStreamFresh(track)) await this.deps.refreshStream(track);
      check();
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await this.deps.fetchAudio(track.streamUrl);
      check();
      if (response.noPermission) {
        this.status.set(key, 'unavailable');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      const samples = await this.deps.decode(base64ToBytes(response.audioBase64));
      check();
      const waveform = computeWaveform(samples, WAVEFORM_SAMPLE_RATE);
      if (!(waveform.seconds > 0)) throw new Error('The audio decoded to nothing');
      this.waveforms.set(key, waveform);
      this.status.delete(key);
      this.retryAt.delete(key);
      this.deps.write(key, waveform);
    } catch (err) {
      if (err instanceof Superseded) return;
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

async function decodeToMono(bytes: Uint8Array): Promise<Float32Array> {
  // An offline context decodes straight to the waveform's rate and, unlike an
  // AudioContext, holds no audio device that would need closing.
  const context = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.buffer as ArrayBuffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return mixToMono(channels);
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
    fetchAudio: (url) => sendBcpMessage({ type: 'fetch-audio', url, whole: true }),
    decode: decodeToMono,
    read: readWaveform,
    write: writeWaveform,
  });
}
