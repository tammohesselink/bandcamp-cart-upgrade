import { describe, it, expect } from 'vitest';
import { computeWaveform, decodeWaveform, encodeWaveform, waveformBars } from '../src/waveform';

describe('computeWaveform', () => {
  it('keeps the loudest sample of each stretch, scaled so the loudest is 1', () => {
    const samples = new Float32Array([0.1, -0.2, 0.4, -0.8, 0, 0, 0.2, 0.1]);
    const { peaks, seconds } = computeWaveform([samples], 4, 4);
    expect(Array.from(peaks)).toEqual([0.25, 1, 0, 0.25]);
    expect(seconds).toBe(2);
  });

  it('takes the loudest of all channels', () => {
    const left = new Float32Array([0.5, 0, 0, 0]);
    const right = new Float32Array([0, 0, 0, -1]);
    expect(Array.from(computeWaveform([left, right], 2, 2).peaks)).toEqual([0.5, 1]);
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
