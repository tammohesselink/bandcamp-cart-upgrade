import { describe, it, expect } from 'vitest';
import { WAVEFORM_TYPICAL_HEIGHT, computeWaveform, decodeWaveform, encodeWaveform, waveformBars } from '../src/waveform';

describe('computeWaveform', () => {
  it('scales so the loudest stretch is 1 and the typical one sits at the typical height', () => {
    // RMS of each stretch: 1, 0.5, 0.5, 0.25, 0.5 -> median 0.5.
    const samples = new Float32Array([1, -1, 0.5, -0.5, 0.5, -0.5, 0.25, -0.25, 0.5, -0.5]);
    const { peaks, seconds } = computeWaveform([samples], 5, 5);
    expect(peaks[0]).toBeCloseTo(1);
    expect(peaks[1]).toBeCloseTo(WAVEFORM_TYPICAL_HEIGHT);
    expect(peaks[3]!).toBeLessThan(peaks[1]!);
    expect(seconds).toBe(2);
  });

  it('stretches out small differences in a track of near equal loudness', () => {
    const samples = new Float32Array([1, -1, 0.9, -0.9, 0.9, -0.9, 0.9, -0.9]);
    const { peaks } = computeWaveform([samples], 4, 4);
    expect(peaks[0]).toBeCloseTo(1);
    expect(peaks[1]!).toBeLessThan(0.75);
  });

  it('lifts the quiet parts of a dynamic track', () => {
    // RMS 1, then 0.1 for most of it: drawn as power or RMS, 0.1 barely shows.
    const samples = new Float32Array([1, -1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1]);
    const { peaks } = computeWaveform([samples], 4, 4);
    expect(peaks[1]!).toBeGreaterThan(0.3);
  });

  it('shows a quieter stretch lower even when its loudest samples are as loud', () => {
    // Both stretches hit full scale once; the second is otherwise much quieter.
    const samples = new Float32Array([1, 0.9, -0.9, 0.9, 1, 0.1, -0.1, 0.1]);
    const { peaks } = computeWaveform([samples], 4, 2);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]!).toBeLessThan(0.6);
  });

  it('takes all channels into account', () => {
    const left = new Float32Array([0.5, -0.5, 0, 0]);
    const right = new Float32Array([0, 0, 1, -1]);
    const { peaks } = computeWaveform([left, right], 2, 2);
    expect(peaks[1]).toBe(1);
    expect(peaks[0]!).toBeGreaterThan(0.1);
    expect(peaks[0]!).toBeLessThan(1);
  });

  it('lifts a quiet track with one loud moment instead of flattening it', () => {
    // One stretch at full scale, the other nine at 0.03 of it.
    const samples = new Float32Array(20).fill(0.03);
    samples[0] = 1;
    samples[1] = -1;
    const { peaks } = computeWaveform([samples], 10, 10);
    expect(peaks[0]).toBeCloseTo(1);
    expect(peaks[5]!).toBeGreaterThan(0.1);
  });

  it('draws the levels as they are when most of the track is at the loudest level', () => {
    const samples = new Float32Array([1, -1, 1, -1, 1, -1, 0.9, -0.9]);
    const { peaks } = computeWaveform([samples], 4, 4);
    expect(peaks[3]).toBeCloseTo(0.9);
  });

  it('leaves silent intros out of the typical loudness', () => {
    // A silent half, then a loud stretch and three at half its RMS.
    const samples = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5]);
    const { peaks } = computeWaveform([samples], 8, 8);
    expect(peaks[0]).toBe(0);
    expect(peaks[5]).toBeCloseTo(WAVEFORM_TYPICAL_HEIGHT);
  });

  it('gives silence all zeros', () => {
    const { peaks } = computeWaveform([new Float32Array(100)], 10, 5);
    expect(Array.from(peaks)).toEqual([0, 0, 0, 0, 0]);
  });

  it('copes with fewer samples than peaks', () => {
    const { peaks } = computeWaveform([new Float32Array([0.5, -1])], 2, 4);
    expect(peaks.length).toBe(4);
    expect(Math.max(...peaks)).toBe(1);
  });

  it('covers no time for no audio', () => {
    expect(computeWaveform([new Float32Array(0)], 8000).seconds).toBe(0);
  });
});

describe('waveformBars', () => {
  const waveform = { peaks: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]), seconds: 8 };

  it('takes the loudest peak under each bar', () => {
    expect(Array.from(waveformBars(waveform, 8, 4))).toEqual([0.2, 0.4, 0.6, 0.8].map(Math.fround));
  });

  it('stretches peaks over more bars than there are peaks', () => {
    const bars = waveformBars(waveform, 8, 16);
    expect(bars[0]).toBeCloseTo(0.1);
    expect(bars[15]).toBeCloseTo(0.8);
  });

  it('leaves the part of a track past the downloaded audio flat', () => {
    // Only the first 8 s of a 16 s track was downloaded.
    const bars = Array.from(waveformBars(waveform, 16, 4));
    expect(bars[0]).toBeCloseTo(0.4);
    expect(bars[1]).toBeCloseTo(0.8);
    expect(bars.slice(2)).toEqual([0, 0]);
  });

  it('spreads over the audio when the listed length is shorter or unknown', () => {
    expect(Array.from(waveformBars(waveform, 7, 2))).toEqual(Array.from(waveformBars(waveform, 8, 2)));
    expect(Array.from(waveformBars(waveform, NaN, 2))).toEqual(Array.from(waveformBars(waveform, 8, 2)));
  });
});

describe('encodeWaveform / decodeWaveform', () => {
  it('round-trips to within a byte of precision', () => {
    const waveform = { peaks: new Float32Array([0, 0.25, 0.5, 1]), seconds: 123.4 };
    const decoded = decodeWaveform(JSON.parse(JSON.stringify(encodeWaveform(waveform))))!;
    expect(decoded.seconds).toBe(123.4);
    decoded.peaks.forEach((value, i) => expect(value).toBeCloseTo(waveform.peaks[i]!, 2));
  });

  it('rejects anything that is not a stored waveform', () => {
    expect(decodeWaveform(undefined)).toBeNull();
    expect(decodeWaveform({ peaks: 'AAAA' })).toBeNull();
    expect(decodeWaveform({ peaks: '', seconds: 10 })).toBeNull();
    expect(decodeWaveform({ peaks: '%%%', seconds: 10 })).toBeNull();
    expect(decodeWaveform({ peaks: 'AAAA', seconds: 0 })).toBeNull();
  });
});
