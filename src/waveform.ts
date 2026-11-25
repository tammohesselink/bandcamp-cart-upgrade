// The waveform shown in place of the seek bar: how loud each stretch of a track
// is, worked out once from its audio and kept small enough to store per track.
// Everything here is pure, so it runs the same in tests as in the page.

import { base64ToBytes, bytesToBase64 } from './audio-fetch';

// Audio is decoded at this rate for the waveform. It only has to show how loud
// each stretch is, and 8 kHz is the lowest rate every browser decodes to.
export const WAVEFORM_SAMPLE_RATE = 8000;

// How many loudness values are kept per track: more than the widest bar has
// pixels for, so drawing never has to stretch them.
export const WAVEFORM_PEAK_COUNT = 1200;

export interface Waveform {
  // Loudness of equal stretches of the audio, from 0 (silence) to 1 (the
  // loudest stretch of the track), with each track's contrast evened out (see
  // computeWaveform).
  peaks: Float32Array;
  // How many seconds of audio the peaks cover. Less than the track's length
  // when only its start could be downloaded (a long mix).
  seconds: number;
}

// Stored waveforms are kept under keys starting with this. Bumped whenever
// computeWaveform changes what a peak means, so older ones are drawn again
// (and the old entries pruned, see pruneTrackCache).
export const WAVEFORM_KEY_FAMILY = 'bcp_waveform_';
export const WAVEFORM_KEY_PREFIX = `${WAVEFORM_KEY_FAMILY}v2_`;

// How high the bar of a stretch of typical loudness (the track's median) is
// drawn, from 0 to 1. See computeWaveform.
export const WAVEFORM_TYPICAL_HEIGHT = 0.6;

// How loud each of `count` equal stretches of the audio is, over all its
// channels, from 0 (silence) to 1 (the loudest stretch). Reads the channels as
// decoded, so a long mix isn't copied once more to mix it down.
//
// Loudness is the stretch's RMS rather than its loudest sample: mastered music
// hits close to full scale in almost every stretch, so loudest samples draw a
// flat bar. RMS alone still varies only a little in a heavily compressed
// track, and a lot in a quiet, dynamic one, so each track's values are then
// raised to the power that puts its median at WAVEFORM_TYPICAL_HEIGHT: small
// differences in a loud master are stretched out, and the quiet parts of a
// dynamic track are lifted so they don't vanish.
export function computeWaveform(channels: Float32Array[], sampleRate: number, count = WAVEFORM_PEAK_COUNT): Waveform {
  const peaks = new Float32Array(count);
  const length = channels.length > 0 ? Math.min(...channels.map((channel) => channel.length)) : 0;
  if (length === 0) return { peaks, seconds: 0 };
  let loudest = 0;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * length) / count);
    const to = Math.min(length, Math.max(from + 1, Math.floor(((i + 1) * length) / count)));
    let sumOfSquares = 0;
    for (const channel of channels) {
      for (let j = from; j < to; j++) {
        const value = channel[j]!;
        sumOfSquares += value * value;
      }
    }
    const rms = Math.sqrt(sumOfSquares / ((to - from) * channels.length));
    peaks[i] = rms;
    if (rms > loudest) loudest = rms;
  }
  if (loudest === 0) return { peaks, seconds: length / sampleRate };
  for (let i = 0; i < count; i++) peaks[i] = peaks[i]! / loudest;
  const exponent = contrastExponent(peaks);
  for (let i = 0; i < count; i++) peaks[i] = Math.pow(peaks[i]!, exponent);
  return { peaks, seconds: length / sampleRate };
}

// Stretches quieter than this (relative to the loudest, -60 dB) are left out
// of the median: a silent intro, outro or gap shouldn't count as the track's
// typical loudness. Only silence: a quiet track with one loud moment still
// takes its typical loudness from the quiet part, and so is lifted.
const SILENT = 0.001;
// Bounds on the exponent, so a track of near equal loudness throughout isn't
// stretched into noise, and a mostly quiet one isn't lifted to the top.
const MIN_EXPONENT = 0.5;
const MAX_EXPONENT = 6;

// The power that takes the median of the non-silent `levels` (0 to 1, the
// loudest being 1) to WAVEFORM_TYPICAL_HEIGHT.
function contrastExponent(levels: Float32Array): number {
  const heard = Array.from(levels).filter((level) => level >= SILENT).sort((a, b) => a - b);
  if (heard.length === 0) return 1;
  const middle = heard.length / 2;
  const median = heard.length % 2 === 1 ? heard[Math.floor(middle)]! : (heard[middle - 1]! + heard[middle]!) / 2;
  // Most of the track is as loud as its loudest stretch: no typical level
  // below the top to aim for, so the levels are drawn as they are.
  if (median >= 1) return 1;
  const exponent = Math.log(WAVEFORM_TYPICAL_HEIGHT) / Math.log(median);
  return Math.max(MIN_EXPONENT, Math.min(MAX_EXPONENT, exponent));
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
  return { peaks: bytesToBase64(bytes), seconds: waveform.seconds };
}

export function decodeWaveform(stored: unknown): Waveform | null {
  if (!stored || typeof stored !== 'object') return null;
  const { peaks, seconds } = stored as Record<string, unknown>;
  if (typeof peaks !== 'string' || typeof seconds !== 'number' || !(seconds > 0)) return null;
  try {
    const bytes = base64ToBytes(peaks);
    if (bytes.length === 0) return null;
    return { peaks: Float32Array.from(bytes, (byte) => byte / 255), seconds };
  } catch {
    return null;
  }
}
