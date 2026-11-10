// Tempo (BPM) detection and the arithmetic that ties a track's BPM to the
// player's tempo slider. Everything here is pure, so it runs the same in tests
// as on decoded audio in the page.

export interface TempoEstimate {
  bpm: number;
  // 0 (a guess) to 1 (a clear, steady beat).
  confidence: number;
}

// Audio is decoded at this rate before analysis. Kick drums, snares and
// hi-hats all still show up below its 5.5 kHz limit, and it keeps the analysis
// of a few minutes of audio to a fraction of a second.
export const ANALYSIS_SAMPLE_RATE = 11025;

// At most this much audio is analysed: enough for a steady estimate without
// stalling the page on a long DJ mix.
export const ANALYSIS_MAX_SECONDS = 150;

export const MIN_BPM = 60;
export const MAX_BPM = 200;

// Below this a detected BPM is shown as a rough guess ("~").
export const LOW_CONFIDENCE = 0.35;

const FRAME_SIZE = 512;
const HOP_SIZE = 128;

// Tempos either side of this are equally plausible to the detector (a beat at
// 64 BPM is also a beat at 128), so it leans towards the tempos most music,
// and dance music especially, is played at.
const PREFERRED_BPM = 128;
const PREFERENCE_WIDTH_OCTAVES = 0.8;

const COARSE_STEP_BPM = 0.5;
const FINE_STEP_BPM = 0.01;
const COARSE_HARMONICS = 4;
const FINE_HARMONICS = 16;

// Estimates the tempo of mono audio, or returns null when there is too little
// of it, or no beat to find (silence).
export function detectTempo(samples: Float32Array, sampleRate: number): TempoEstimate | null {
  const maxSamples = Math.floor(ANALYSIS_MAX_SECONDS * sampleRate);
  const audio = samples.length > maxSamples ? samples.subarray(0, maxSamples) : samples;
  const { envelope, framesPerSecond } = onsetEnvelope(audio, sampleRate);
  // Fewer than ~8 seconds can't pin a tempo down.
  if (envelope.length < framesPerSecond * 8) return null;

  const maxLag = Math.ceil(((framesPerSecond * 60) / (MIN_BPM - 1)) * FINE_HARMONICS) + 2;
  const correlation = autocorrelation(envelope, Math.min(maxLag, envelope.length - 1));
  if (!(correlation[0]! > 0)) return null;

  const periodOf = (bpm: number) => (framesPerSecond * 60) / bpm;

  // Coarse search over the whole range, weighted towards likely tempos.
  let bestBpm = MIN_BPM;
  let bestScore = -Infinity;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += COARSE_STEP_BPM) {
    const score = combScore(correlation, periodOf(bpm), COARSE_HARMONICS) * tempoPreference(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  if (!(bestScore > 0)) return null;

  // Fine search near the winner. Many beats' worth of lag pins the period down
  // to a hundredth of a BPM; the preference weighting would only skew it.
  let refinedBpm = bestBpm;
  let refinedScore = -Infinity;
  for (let bpm = bestBpm - 1; bpm <= bestBpm + 1; bpm += FINE_STEP_BPM) {
    const score = combScore(correlation, periodOf(bpm), FINE_HARMONICS);
    if (score > refinedScore) {
      refinedScore = score;
      refinedBpm = bpm;
    }
  }

  return { bpm: roundBpm(refinedBpm), confidence: confidenceOf(refinedScore / correlation[0]!) };
}

// Spectral flux: how much louder each frequency got since the previous frame,
// summed over all frequencies. It peaks at every note and drum hit, which is
// what the beat is made of. Local averages are subtracted, so only the peaks
// remain and a quiet intro weighs as much as a loud drop.
export function onsetEnvelope(samples: Float32Array, sampleRate: number): { envelope: Float32Array; framesPerSecond: number } {
  const framesPerSecond = sampleRate / HOP_SIZE;
  const frameCount = samples.length >= FRAME_SIZE ? Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1 : 0;
  const flux = new Float32Array(frameCount);
  const bins = FRAME_SIZE / 2 + 1;
  const window = hannWindow(FRAME_SIZE);
  const real = new Float64Array(FRAME_SIZE);
  const imaginary = new Float64Array(FRAME_SIZE);
  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);

  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      real[i] = samples[offset + i]! * window[i]!;
      imaginary[i] = 0;
    }
    fft(real, imaginary);
    let sum = 0;
    for (let bin = 0; bin < bins; bin++) {
      const magnitude = Math.log1p(100 * Math.hypot(real[bin]!, imaginary[bin]!));
      current[bin] = magnitude;
      if (frame > 0 && magnitude > previous[bin]!) sum += magnitude - previous[bin]!;
    }
    flux[frame] = sum;
    [previous, current] = [current, previous];
  }

  const envelope = subtractLocalMean(flux, Math.max(1, Math.round(framesPerSecond * 0.25)));
  return { envelope, framesPerSecond };
}

// Keeps only what rises above the average of the surrounding `radius` frames.
function subtractLocalMean(values: Float32Array, radius: number): Float32Array {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i]! + values[i]!;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length, i + radius + 1);
    const mean = (prefix[to]! - prefix[from]!) / (to - from);
    out[i] = Math.max(0, values[i]! - mean);
  }
  return out;
}

// How strongly the envelope repeats itself after each lag, for lags 0..maxLag.
// The mean is removed first so a constant level doesn't count as repetition.
function autocorrelation(values: Float32Array, maxLag: number): Float64Array {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  const centred = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) centred[i] = values[i]! - mean;

  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    const n = centred.length - lag;
    for (let i = 0; i < n; i++) sum += centred[i]! * centred[i + lag]!;
    out[lag] = sum / n;
  }
  return out;
}

// The average repetition at whole multiples of a beat period. A real tempo
// repeats at every multiple, a wrong one only at some.
function combScore(correlation: Float64Array, period: number, harmonics: number): number {
  let sum = 0;
  let counted = 0;
  for (let k = 1; k <= harmonics; k++) {
    const lag = period * k;
    if (lag >= correlation.length - 1) break;
    sum += correlationAt(correlation, lag);
    counted++;
  }
  return counted > 0 ? sum / counted : 0;
}

// The correlation at a fractional lag, interpolated between whole frames.
function correlationAt(correlation: Float64Array, lag: number): number {
  const below = Math.floor(lag);
  const fraction = lag - below;
  return correlation[below]! * (1 - fraction) + correlation[below + 1]! * fraction;
}

function tempoPreference(bpm: number): number {
  const octaves = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_WIDTH_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

// How much of the envelope repeats at the beat period: near 1 for a drum
// machine, near 0 for noise.
function confidenceOf(periodicity: number): number {
  return Math.max(0, Math.min(1, periodicity / 0.3));
}

function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

// In-place iterative radix-2 FFT. `real.length` must be a power of two.
function fft(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imaginary[i], imaginary[j]] = [imaginary[j]!, imaginary[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const productReal = real[b]! * twiddleReal - imaginary[b]! * twiddleImaginary;
        const productImaginary = real[b]! * twiddleImaginary + imaginary[b]! * twiddleReal;
        real[b] = real[a]! - productReal;
        imaginary[b] = imaginary[a]! - productImaginary;
        real[a] = real[a]! + productReal;
        imaginary[a] = imaginary[a]! + productImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

// Averages channels into one.
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i]!;
  }
  for (let i = 0; i < length; i++) mono[i] /= channels.length;
  return mono;
}

export function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

export function formatBpm(bpm: number): string {
  return roundBpm(bpm).toFixed(1);
}

// --- Tying a BPM to the tempo slider -------------------------------------------

// The BPM a track is heard at when played at `rate`.
export function effectiveBpm(trackBpm: number, rate: number): number {
  return trackBpm * rate;
}

// The playback rate that plays a track of `trackBpm` at exactly `targetBpm`.
export function rateForTargetBpm(trackBpm: number, targetBpm: number): number {
  return targetBpm / trackBpm;
}

// The playback rate that beat-matches a track of `trackBpm` to `targetBpm`,
// playing it double or half time when that needs less of a tempo change, as a
// DJ would: an 87 BPM track mixes into a 174 BPM set at its own tempo.
export function rateToMatchBpm(trackBpm: number, targetBpm: number): number {
  const candidates = [1, 2, 0.5].map((factor) => (targetBpm * factor) / trackBpm);
  return candidates.reduce((best, rate) => (Math.abs(Math.log(rate)) < Math.abs(Math.log(best)) ? rate : best));
}

// The BPM of a run of taps (times in milliseconds), or null for fewer than two.
// A least-squares line through all the taps, rather than the average gap, so
// one early or late tap barely moves it.
export function tappedBpm(tapTimes: number[]): number | null {
  const n = tapTimes.length;
  if (n < 2) return null;
  const meanIndex = (n - 1) / 2;
  const meanTime = tapTimes.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  tapTimes.forEach((time, i) => {
    numerator += (i - meanIndex) * (time - meanTime);
    denominator += (i - meanIndex) * (i - meanIndex);
  });
  const msPerBeat = numerator / denominator;
  if (!(msPerBeat > 0)) return null;
  return roundBpm(60000 / msPerBeat);
}

// A pause this long between taps starts a new run.
export const TAP_RESET_MS = 2000;
// Only the most recent taps count, so a tempo change while tapping catches up.
export const TAP_WINDOW = 16;

// Taps closer together than this (400 BPM) are a bounce, not a beat.
export const TAP_MIN_INTERVAL_MS = 150;

export function addTap(tapTimes: number[], now: number): number[] {
  const last = tapTimes[tapTimes.length - 1];
  if (last !== undefined && now - last > TAP_RESET_MS) return [now];
  if (last !== undefined && now - last < TAP_MIN_INTERVAL_MS) return tapTimes;
  return [...tapTimes, now].slice(-TAP_WINDOW);
}
