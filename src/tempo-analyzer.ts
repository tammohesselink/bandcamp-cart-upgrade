import type { PlaylistTrack } from './types';
import type { FetchAudioResponse } from './messages';
import { sendBcpMessage } from './messages';
import { ANALYSIS_SAMPLE_RATE, detectTempo, mixToMono, type TempoEstimate } from './tempo-analysis';
import { readTempos, trackTempoKey, writeTempo, type StoredTempo } from './tempo-store';
import { base64ToBytes } from './audio-fetch';
import { isStreamFresh } from './cache';
import { log } from './log';

// 'unavailable': the track can't be streamed, so there is nothing to analyse.
// 'no-permission': tempo analysis is off, or its permission was taken away.
export type TempoStatus = 'none' | 'queued' | 'analyzing' | 'failed' | 'unavailable' | 'no-permission';

export interface TrackTempo {
  bpm: number | null;
  confidence: number;
  source: StoredTempo['source'] | null;
  status: TempoStatus;
}

export interface TempoAnalyzerDeps {
  // Gives the track a fresh stream link (see Player.onRefreshStream).
  refreshStream: (track: PlaylistTrack, bulk: boolean) => Promise<void>;
  fetchAudio: (url: string, bulk: boolean) => Promise<FetchAudioResponse>;
  // Decodes audio file bytes to mono samples at ANALYSIS_SAMPLE_RATE.
  decode: (bytes: Uint8Array) => Promise<Float32Array>;
  analyse: (samples: Float32Array, sampleRate: number) => TempoEstimate | null;
  read: (keys: string[]) => Promise<Map<string, StoredTempo>>;
  write: (key: string, tempo: StoredTempo) => void;
}

interface Job {
  track: PlaylistTrack;
  key: string;
  bulk: boolean;
}

// Decoding and analysis use the page's main thread, so only this many run at
// once; downloads are limited in the background as well.
const CONCURRENCY = 2;

// Finds and remembers the BPM of tracks: from storage when it was found
// before, otherwise by downloading the start of the track and analysing it.
export class TempoAnalyzer {
  private stored = new Map<string, StoredTempo>();
  private status = new Map<string, TempoStatus>();
  private queue: Job[] = [];
  private running = 0;
  private listeners = new Set<() => void>();
  private enabled = false;

  constructor(private deps: TempoAnalyzerDeps) {}

  // Whether "Detect track BPMs" is on. While off, nothing is downloaded and the
  // player hides its BPM controls.
  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const job of this.queue) this.status.delete(job.key);
      this.queue = [];
    } else {
      for (const [key, status] of this.status) if (status === 'no-permission') this.status.delete(key);
    }
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(track: PlaylistTrack): TrackTempo {
    const key = trackTempoKey(track);
    const stored = this.stored.get(key);
    const status = this.status.get(key) ?? (track.unplayable ? 'unavailable' : 'none');
    return {
      bpm: stored?.bpm ?? null,
      confidence: stored?.confidence ?? 0,
      source: stored?.source ?? null,
      status: !this.enabled && status === 'none' ? 'no-permission' : status,
    };
  }

  // Loads what is already known about these tracks, e.g. when a playlist is set.
  async load(tracks: PlaylistTrack[]): Promise<void> {
    const keys = [...new Set(tracks.map(trackTempoKey))].filter((key) => !this.stored.has(key));
    if (keys.length === 0) return;
    const found = await this.deps.read(keys);
    if (found.size === 0) return;
    for (const [key, tempo] of found) if (!this.stored.has(key)) this.stored.set(key, tempo);
    this.notify();
  }

  // Detects the track's BPM unless it is already known or on its way. `force`
  // detects again, replacing whatever is known, including a hand-set BPM.
  // `bulk` waits behind tracks someone is waiting on, e.g. the one playing.
  analyse(track: PlaylistTrack, { force = false, bulk = false }: { force?: boolean; bulk?: boolean } = {}): void {
    if (!this.enabled || track.unplayable) return;
    const key = trackTempoKey(track);
    const status = this.status.get(key);
    if (status === 'analyzing') return;
    if (!force && (this.stored.has(key) || status === 'failed')) return;
    const queued = this.queue.findIndex((job) => job.key === key);
    if (queued !== -1) {
      if (bulk || !this.queue[queued]!.bulk) return;
      this.queue.splice(queued, 1);
    }
    const job = { track, key, bulk };
    const firstBulk = this.queue.findIndex((j) => j.bulk);
    if (bulk || firstBulk === -1) this.queue.push(job);
    else this.queue.splice(firstBulk, 0, job);
    this.status.set(key, 'queued');
    this.notify();
    this.startNext();
  }

  // Saves a BPM the user set, e.g. by typing or tapping it.
  setBpm(track: PlaylistTrack, bpm: number): void {
    if (!(bpm > 0) || !isFinite(bpm)) return;
    const key = trackTempoKey(track);
    const tempo: StoredTempo = { bpm, confidence: 1, source: 'manual', savedAt: Date.now() };
    this.stored.set(key, tempo);
    this.status.delete(key);
    this.deps.write(key, tempo);
    this.notify();
  }

  private startNext(): void {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.startNext();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { track, key, bulk } = job;
    this.status.set(key, 'analyzing');
    this.notify();
    try {
      if (!isStreamFresh(track)) await this.deps.refreshStream(track, bulk);
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await this.deps.fetchAudio(track.streamUrl, bulk);
      if (response.noPermission) {
        // Every other track would be refused too.
        for (const queued of this.queue) this.status.set(queued.key, 'no-permission');
        this.queue = [];
        this.status.set(key, 'no-permission');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      const samples = await this.deps.decode(base64ToBytes(response.audioBase64));
      // Lets the page draw before the analysis takes the main thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const estimate = this.deps.analyse(samples, ANALYSIS_SAMPLE_RATE);
      if (!estimate) throw new Error('No beat found');
      const tempo: StoredTempo = { ...estimate, source: 'detected', savedAt: Date.now() };
      this.stored.set(key, tempo);
      this.deps.write(key, tempo);
      this.status.delete(key);
      log.info('[bcp] Detected tempo', track.trackTitle, estimate);
    } catch (err) {
      log.warn('[bcp] Tempo detection failed for', track.trackTitle, err);
      this.status.set(key, 'failed');
    } finally {
      // A track turned off mid-run stays as it was found.
      if (!this.enabled && this.status.get(key) !== 'failed') this.status.delete(key);
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

async function decodeToMono(bytes: Uint8Array): Promise<Float32Array> {
  // An offline context decodes straight to the analysis rate and, unlike an
  // AudioContext, holds no audio device that would need closing.
  const context = new OfflineAudioContext(1, 1, ANALYSIS_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return mixToMono(channels);
}

export function createTempoAnalyzer(refreshStream: TempoAnalyzerDeps['refreshStream']): TempoAnalyzer {
  return new TempoAnalyzer({
    refreshStream,
    fetchAudio: (url, bulk) => sendBcpMessage({ type: 'fetch-audio', url, bulk }),
    decode: decodeToMono,
    analyse: detectTempo,
    read: readTempos,
    write: writeTempo,
  });
}
