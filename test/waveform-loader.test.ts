import { describe, it, expect, vi } from 'vitest';
import { WAVEFORM_RETRY_AFTER_MS, WaveformLoader, trackWaveformKey, type WaveformLoaderDeps } from '../src/waveform-loader';
import type { Waveform } from '../src/waveform';
import { bytesToBase64 } from '../src/audio-fetch';
import type { PlaylistTrack } from '../src/types';
import { makeTrack } from './track-factory';

function track(n: number, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return makeTrack({
    trackTitle: `Track ${n}`,
    trackId: n,
    pageUrl: `https://solardrift.bandcamp.com/track/track-${n}`,
    streamUrl: `https://t4.bcbits.com/stream/track-${n}`,
    streamFetchedAt: Date.now(),
    ...overrides,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(overrides: Partial<WaveformLoaderDeps> = {}, stored = new Map<string, Waveform>()) {
  const written = new Map<string, Waveform>();
  const deps: WaveformLoaderDeps = {
    refreshStream: vi.fn(async (t: PlaylistTrack) => { t.streamFetchedAt = Date.now(); }),
    fetchAudio: vi.fn(async () => ({ audioBase64: bytesToBase64(new Uint8Array([1, 2, 3])) })),
    // Two seconds of audio at the waveform's rate.
    decode: vi.fn(async () => new Float32Array(16000).fill(0.5)),
    read: vi.fn(async (key: string) => stored.get(key) ?? null),
    write: vi.fn((key: string, waveform: Waveform) => { written.set(key, waveform); }),
    ...overrides,
  };
  const loader = new WaveformLoader(deps);
  loader.setEnabled(true);
  return { loader, deps, written };
}

describe('WaveformLoader', () => {
  it('downloads, draws and stores the waveform of a track', async () => {
    const { loader, deps, written } = setup();
    const t = track(1);

    loader.request(t);
    expect(loader.get(t).status).toBe('loading');
    await settle();

    expect(deps.fetchAudio).toHaveBeenCalledWith(t.streamUrl);
    expect(loader.get(t).status).toBe('ready');
    expect(loader.get(t).waveform!.seconds).toBe(2);
    expect(written.has(trackWaveformKey(t))).toBe(true);
  });

  it('uses a stored waveform without downloading the track', async () => {
    const t = track(1);
    const stored = new Map([[trackWaveformKey(t), { peaks: new Float32Array([1]), seconds: 60 }]]);
    const { loader, deps } = setup({}, stored);

    await loader.loadStored(t);
    expect(loader.get(t).status).toBe('ready');
    loader.request(t);
    await settle();
    expect(deps.fetchAudio).not.toHaveBeenCalled();
  });

  it('only loads the latest of several tracks asked for while one loads', async () => {
    const { loader, deps } = setup();
    const [a, b, c] = [track(1), track(2), track(3)];

    loader.request(a);
    loader.request(b);
    loader.request(c);
    expect(loader.get(b).status).toBe('none');
    await settle();

    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url]) => url)).toEqual([a.streamUrl, c.streamUrl]);
    expect(loader.get(c).status).toBe('ready');
  });

  it('refreshes a stale stream link before downloading', async () => {
    const { loader, deps } = setup();
    const t = track(1, { streamFetchedAt: 0 });
    loader.request(t);
    await settle();
    expect(deps.refreshStream).toHaveBeenCalledWith(t);
    expect(loader.get(t).status).toBe('ready');
  });

  it('retries a failed download only after a while', async () => {
    const fetchAudio = vi.fn(async () => ({ error: 'HTTP 500' }));
    const { loader } = setup({ fetchAudio });
    const t = track(1);

    loader.request(t);
    await settle();
    expect(loader.get(t).status).toBe('error');
    loader.request(t);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
    loader.request(t);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('gives up on a track when the stream permission is missing', async () => {
    const { loader } = setup({ fetchAudio: vi.fn(async () => ({ noPermission: true })) });
    const t = track(1);
    loader.request(t);
    await settle();
    expect(loader.get(t).status).toBe('unavailable');
  });

  it('downloads nothing while off, and drops a load that was running when turned off', async () => {
    let finishDecode!: (samples: Float32Array) => void;
    const decode = vi.fn(() => new Promise<Float32Array>((resolve) => { finishDecode = resolve; }));
    const { loader, deps, written } = setup({ decode });
    const t = track(1);

    loader.request(t);
    await settle();
    loader.setEnabled(false);
    finishDecode(new Float32Array(8000));
    await settle();
    expect(loader.get(t).status).toBe('none');
    expect(written.size).toBe(0);

    loader.request(track(2));
    await settle();
    expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a track that cannot be streamed', () => {
    const { loader, deps } = setup();
    const t = track(1, { unplayable: true });
    loader.request(t);
    expect(loader.get(t).status).toBe('unavailable');
    expect(deps.read).not.toHaveBeenCalled();
  });
});
