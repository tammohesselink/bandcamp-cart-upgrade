import { describe, it, expect } from 'vitest';
import { base64ToBytes, bytesToBase64, isStreamUrl, readCapped } from '../src/audio-fetch';

describe('isStreamUrl', () => {
  it('accepts Bandcamp stream hosts only', () => {
    expect(isStreamUrl('https://t4.bcbits.com/stream/abc/mp3-128/1?token=x')).toBe(true);
    expect(isStreamUrl('https://bandcamp.com/stream_redirect?enc=mp3-128')).toBe(true);
    expect(isStreamUrl('https://evil.example.com/bcbits.com')).toBe(false);
    expect(isStreamUrl('http://t4.bcbits.com/stream/abc')).toBe(false);
    expect(isStreamUrl('not a url')).toBe(false);
  });
});

describe('readCapped', () => {
  it('stops reading at the cap', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(100).fill(i));
        controller.close();
      },
    });
    const bytes = await readCapped(new Response(body), 250);
    expect(bytes.length).toBe(250);
    expect(bytes[249]).toBe(2);
  });

  it('returns a shorter body whole', async () => {
    const bytes = await readCapped(new Response(new Uint8Array([1, 2, 3])), 250);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});

describe('base64', () => {
  it('round-trips bytes, including large ones', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
