import type { PlaylistTrack } from './types';
import type { FetchAudioResponse } from './messages';
import { sendBcpMessage } from './messages';
import { ANALYSIS_SAMPLE_RATE, detectTempo, mixToMono, type TempoEstimate } from './tempo-analysis';
import { readTempos, trackTempoKey, writeTempo, type StoredTempo } from './tempo-store';
import { base64ToBytes } from './audio-fetch';
import { isStreamFresh } from './cache';
import { log } from './log';

// 'failed': the audio has no steady beat; not retried unless asked.
// 'error': the audio couldn't be downloaded or decoded; retried after a while.
// 'unavailable': the track can't be streamed, so there is nothing to analyse.
// 'no-permission': tempo analysis is off, or its permission was taken away.
export type TempoStatus = 'none' | 'queued' | 'analyzing' | 'failed' | 'error' | 'unavailable' | 'no-permission';

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
  force: boolean;
}

// A track whose audio couldn't be downloaded (a dropped connection, a server
// error) is tried again when it is next asked for after this long.
export const ERROR_RETRY_AFTER_MS = 60 * 1000;

class Superseded extends Error {}

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
  // Bumped when detection is turned off, so jobs still running drop their result.
  private generation = 0;
  private retryAt = new Map<string, number>();
  // Counts the BPMs the user set per track, so a detection can tell one was
  // set while it ran.
  private manualEdits = new Map<string, number>();

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
      this.generation++;
      for (const job of this.queue) this.status.delete(job.key);
      this.queue = [];
      for (const [key, status] of this.status) if (status === 'analyzing') this.status.delete(key);
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
    if (!force && status === 'error' && Date.now() < (this.retryAt.get(key) ?? 0)) return;
    const queued = this.queue.findIndex((job) => job.key === key);
    if (queued !== -1) {
      if (bulk || !this.queue[queued]!.bulk) return;
      this.queue.splice(queued, 1);
    }
    const job = { track, key, bulk, force };
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
    this.manualEdits.set(key, (this.manualEdits.get(key) ?? 0) + 1);
    // A detection still waiting would only replace it. One already running
    // sees the newer BPM when it finishes and leaves it (see run).
    this.queue = this.queue.filter((job) => job.key !== key);
    if (this.status.get(key) !== 'analyzing') this.status.delete(key);
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
    const { track, key, bulk, force } = job;
    const generation = this.generation;
    const editsAtStart = this.manualEdits.get(key) ?? 0;
    // Turning detection off mid-run drops the result.
    const check = () => {
      if (generation !== this.generation) throw new Superseded();
    };
    this.status.set(key, 'analyzing');
    this.notify();
    try {
      // load() may not have finished reading this track's saved BPM yet;
      // downloading would then replace it.
      if (!force) {
        const saved = (await this.deps.read([key])).get(key);
        check();
        if (saved) {
          if (!this.stored.has(key)) this.stored.set(key, saved);
          this.status.delete(key);
          return;
        }
      }
      if (!isStreamFresh(track)) await this.deps.refreshStream(track, bulk);
      check();
      if (track.unplayable || !track.streamUrl) {
        this.status.set(key, 'unavailable');
        return;
      }
      const response = await this.deps.fetchAudio(track.streamUrl, bulk);
      check();
      if (response.noPermission) {
        // Every other track would be refused too.
        for (const queued of this.queue) this.status.set(queued.key, 'no-permission');
        this.queue = [];
        this.status.set(key, 'no-permission');
        return;
      }
      if (!response.audioBase64) throw new Error(response.error ?? 'No audio');
      const samples = await this.deps.decode(base64ToBytes(response.audioBase64));
      check();
      // Lets the page draw before the analysis takes the main thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      check();
      const estimate = this.deps.analyse(samples, ANALYSIS_SAMPLE_RATE);
      this.retryAt.delete(key);
      if (!estimate) {
        this.status.set(key, 'failed');
        return;
      }
      this.status.delete(key);
      // A BPM the user set while this ran is newer, and wins.
      if ((this.manualEdits.get(key) ?? 0) !== editsAtStart) return;
      const tempo: StoredTempo = { ...estimate, source: 'detected', savedAt: Date.now() };
      this.stored.set(key, tempo);
      this.deps.write(key, tempo);
      log.info('[bcp] Detected tempo', track.trackTitle, estimate);
    } catch (err) {
      if (err instanceof Superseded) return;
      log.warn('[bcp] Could not get the audio for tempo detection of', track.trackTitle, err);
      this.status.set(key, 'error');
      this.retryAt.set(key, Date.now() + ERROR_RETRY_AFTER_MS);
    } finally {
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
  // base64ToBytes gives an array that owns its whole buffer, so no copy is needed.
  const buffer = await context.decodeAudioData(bytes.buffer as ArrayBuffer);
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
