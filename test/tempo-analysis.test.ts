import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_SAMPLE_RATE,
  addTap,
  detectTempo,
  effectiveBpm,
  formatBpm,
  mixToMono,
  rateForTargetBpm,
  rateToMatchBpm,
  tappedBpm,
  TAP_RESET_MS,
} from '../src/tempo-analysis';

const RATE = ANALYSIS_SAMPLE_RATE;

// A seeded random source, so the noise in these tests is the same every run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface BeatOptions {
  seconds?: number;
  // Hi-hats between the kicks.
  offbeatHats?: boolean;
  // A snare on beats 2 and 4.
  backbeat?: boolean;
  // Background noise level.
  noise?: number;
  // Starts with this many seconds of beatless pad.
  introSeconds?: number;
}

// A drum loop: a kick on every beat, plus optional hats, snares and noise.
function drumLoop(bpm: number, options: BeatOptions = {}): Float32Array {
  const { seconds = 40, offbeatHats = true, backbeat = true, noise = 0.02, introSeconds = 0 } = options;
  const samples = new Float32Array(Math.floor((seconds + introSeconds) * RATE));
  const next = random(42);
  for (let i = 0; i < samples.length; i++) samples[i] = (next() * 2 - 1) * noise;

  const addKick = (at: number) => {
    for (let i = 0; i < 0.12 * RATE; i++) {
      const t = i / RATE;
      const index = at + i;
      if (index >= samples.length) return;
      samples[index] += Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 25) * 0.9;
    }
  };
  const addNoiseBurst = (at: number, length: number, level: number) => {
    for (let i = 0; i < length * RATE; i++) {
      const index = at + i;
      if (index >= samples.length) return;
      samples[index] += (next() * 2 - 1) * level * Math.exp(-(i / RATE) * 60);
    }
  };

  const beatSamples = (60 / bpm) * RATE;
  const start = introSeconds * RATE;
  for (let beat = 0; start + beat * beatSamples < samples.length; beat++) {
    const at = Math.round(start + beat * beatSamples);
    addKick(at);
    if (offbeatHats) addNoiseBurst(Math.round(at + beatSamples / 2), 0.04, 0.3);
    if (backbeat && beat % 2 === 1) addNoiseBurst(at, 0.15, 0.6);
  }
  // A held chord under the intro, which has no beat.
  for (let i = 0; i < start; i++) samples[i] += Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.2;
  return samples;
}

describe('detectTempo', () => {
  it.each([120, 124, 128, 132.5, 140])('finds %s BPM in a four-to-the-floor loop to within 0.1 BPM', (bpm) => {
    const estimate = detectTempo(drumLoop(bpm), RATE);
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.bpm - bpm)).toBeLessThanOrEqual(0.1);
    expect(estimate!.confidence).toBeGreaterThan(0.5);
  });

  it('finds a slow tempo with kicks only', () => {
    const estimate = detectTempo(drumLoop(92, { offbeatHats: false, backbeat: false }), RATE);
    expect(estimate!.bpm).toBeCloseTo(92, 0);
  });

  it('is not put off by a beatless intro', () => {
    const estimate = detectTempo(drumLoop(126, { introSeconds: 10 }), RATE);
    expect(Math.abs(estimate!.bpm - 126)).toBeLessThanOrEqual(0.1);
  });

  it('gives noise without a beat a low confidence', () => {
    const next = random(7);
    const noise = new Float32Array(30 * RATE).map(() => (next() * 2 - 1) * 0.5);
    const estimate = detectTempo(noise, RATE);
    expect(estimate === null || estimate.confidence < 0.35).toBe(true);
  });

  it('returns nothing for silence', () => {
    expect(detectTempo(new Float32Array(30 * RATE), RATE)).toBeNull();
  });

  it('returns nothing for audio too short to tell', () => {
    expect(detectTempo(drumLoop(128, { seconds: 3 }), RATE)).toBeNull();
  });
});

describe('mixToMono', () => {
  it('averages the channels', () => {
    expect(Array.from(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 0.5])]))).toEqual([0.5, 0.25]);
  });
});

describe('BPM and playback rate', () => {
  it('gives the BPM heard at a playback rate', () => {
    expect(effectiveBpm(125, 1.024)).toBeCloseTo(128);
  });

  it('gives the rate that plays a track at a target BPM', () => {
    expect(rateForTargetBpm(125, 128)).toBeCloseTo(1.024);
  });

  it('matches at double or half time when that is the smaller change', () => {
    expect(rateToMatchBpm(87, 174)).toBeCloseTo(1);
    expect(rateToMatchBpm(170, 86)).toBeCloseTo(172 / 170);
    expect(rateToMatchBpm(124, 128)).toBeCloseTo(128 / 124);
  });

  it('formats a BPM with one decimal', () => {
    expect(formatBpm(127.96)).toBe('128.0');
  });
});

describe('tap tempo', () => {
  it('needs two taps', () => {
    expect(tappedBpm([])).toBeNull();
    expect(tappedBpm([1000])).toBeNull();
  });

  it('reads the BPM from evenly spaced taps', () => {
    expect(tappedBpm([0, 500, 1000, 1500])).toBe(120);
  });

  it('is barely moved by one sloppy tap', () => {
    const taps = [0, 500, 1000, 1580, 2000, 2500, 3000, 3500];
    expect(Math.abs(tappedBpm(taps)! - 120)).toBeLessThan(1);
  });

  it('starts a new run after a pause', () => {
    expect(addTap([0, 500], 500 + TAP_RESET_MS + 1)).toEqual([500 + TAP_RESET_MS + 1]);
    expect(addTap([0, 500], 1000)).toEqual([0, 500, 1000]);
  });

  it('ignores a tap that bounces straight after the previous one', () => {
    expect(addTap([0, 500], 510)).toEqual([0, 500]);
  });
});
