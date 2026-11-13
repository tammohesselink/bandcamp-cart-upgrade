// The waveform shown in place of the seek bar: how loud each stretch of a track
// is, worked out once from its audio and kept small enough to store per track.
// Everything here is pure, so it runs the same in tests as in the page.

// Audio is decoded at this rate for the waveform. It only has to show how loud
// each stretch is, and 8 kHz is the lowest rate every browser decodes to.
export const WAVEFORM_SAMPLE_RATE = 8000;

// How many loudness values are kept per track: more than the widest bar has
// pixels for, so drawing never has to stretch them.
export const WAVEFORM_PEAK_COUNT = 1200;

export interface Waveform {
  // Loudness of equal stretches of the audio, from 0 (silence) to 1 (the
  // loudest stretch of the track).
  peaks: Float32Array;
  // How many seconds of audio the peaks cover. Less than the track's length
  // when only its start could be downloaded (a long mix).
  seconds: number;
}

// The loudest sample of each of `count` equal stretches of mono audio, scaled
// so the loudest stretch is 1.
export function computeWaveform(samples: Float32Array, sampleRate: number, count = WAVEFORM_PEAK_COUNT): Waveform {
  const peaks = new Float32Array(count);
  if (samples.length === 0) return { peaks, seconds: 0 };
  let loudest = 0;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * samples.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < samples.length; j++) {
      const value = Math.abs(samples[j]!);
      if (value > peak) peak = value;
    }
    peaks[i] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest > 0) for (let i = 0; i < count; i++) peaks[i] = peaks[i]! / loudest;
  return { peaks, seconds: samples.length / sampleRate };
}

// The height of each of `barCount` bars drawn across a track `duration`
// seconds long, from 0 to 1. Bars past the end of the downloaded audio are 0.
export function waveformBars(waveform: Waveform, duration: number, barCount: number): Float32Array {
  const bars = new Float32Array(barCount);
  const { peaks, seconds } = waveform;
  if (barCount <= 0 || peaks.length === 0 || !(seconds > 0)) return bars;
  // A track's listed length can be a little shorter than its audio.
  const total = duration > 0 && isFinite(duration) ? Math.max(duration, seconds) : seconds;
  for (let bar = 0; bar < barCount; bar++) {
    const startTime = (bar / barCount) * total;
    if (startTime >= seconds) break;
    const endTime = Math.min(seconds, ((bar + 1) / barCount) * total);
    const from = Math.floor((startTime / seconds) * peaks.length);
    const to = Math.max(from + 1, Math.ceil((endTime / seconds) * peaks.length));
    let height = 0;
    for (let i = from; i < to && i < peaks.length; i++) if (peaks[i]! > height) height = peaks[i]!;
    bars[bar] = height;
  }
  return bars;
}

// --- Storage -------------------------------------------------------------------

// Stored as one byte per peak, base64 encoded: about 1.6 kB a track.
export interface StoredWaveform {
  peaks: string;
  seconds: number;
}

export function encodeWaveform(waveform: Waveform): StoredWaveform {
  const bytes = new Uint8Array(waveform.peaks.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, waveform.peaks[i]!)) * 255);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { peaks: btoa(binary), seconds: waveform.seconds };
}

export function decodeWaveform(stored: unknown): Waveform | null {
  if (!stored || typeof stored !== 'object') return null;
  const { peaks, seconds } = stored as Record<string, unknown>;
  if (typeof peaks !== 'string' || typeof seconds !== 'number' || !(seconds > 0)) return null;
  try {
    const binary = atob(peaks);
    if (binary.length === 0) return null;
    const values = new Float32Array(binary.length);
    for (let i = 0; i < binary.length; i++) values[i] = binary.charCodeAt(i) / 255;
    return { peaks: values, seconds };
  } catch {
    return null;
  }
}
