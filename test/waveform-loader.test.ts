import { describe, it, expect, vi } from 'vitest';
import { WAVEFORM_DECODE_TIMEOUT_MS, WAVEFORM_RETRY_AFTER_MS, WaveformLoader, trackWaveformKey, type WaveformLoaderDeps } from '../src/waveform-loader';
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
    decode: vi.fn(async () => [new Float32Array(16000).fill(0.5)]),
    read: vi.fn(async (key: string) => stored.get(key) ?? null),
    write: vi.fn((key: string, waveform: Waveform) => { written.set(key, waveform); }),
    promoteAudio: vi.fn(),
    ...overrides,
  };
  const loader = new WaveformLoader(deps);
  loader.setEnabled(true);
  // Loads only start while something plays; this one has no waveform to get.
  loader.setPlaying(track(0, { unplayable: true }));
  return { loader, deps, written };
}

describe('WaveformLoader', () => {
  it('downloads, draws and stores the waveform of a track', async () => {
    const { loader, deps, written } = setup();
    const t = track(1);

    loader.setPlaying(t);
    expect(loader.get(t).status).toBe('loading');
    await settle();

    expect(deps.fetchAudio).toHaveBeenCalledWith(t.streamUrl, expect.any(AbortSignal), false, expect.any(String));
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
    loader.setPlaying(t);
    await settle();
    expect(deps.fetchAudio).not.toHaveBeenCalled();
  });

  it('only loads the last of several tracks asked for in a row', async () => {
    const { loader, deps } = setup();
    const [a, b, c] = [track(1), track(2), track(3)];

    loader.setPlaying(a);
    loader.setPlaying(b);
    loader.setPlaying(c);
    expect(loader.get(b).status).toBe('none');
    await settle();

    // The first was stopped before its download began.
    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url]) => url)).toEqual([c.streamUrl]);
    expect(loader.get(a).status).toBe('none');
    expect(loader.get(c).status).toBe('ready');
  });

  it('stops the download of a track when another is asked for', async () => {
    const signals: AbortSignal[] = [];
    const fetchAudio = vi.fn((_url: string, signal: AbortSignal) => {
      signals.push(signal);
      // Like the background, answers once the download is cancelled.
      return new Promise<{ error: string }>((resolve) => signal.addEventListener('abort', () => resolve({ error: 'Cancelled' })));
    });
    const { loader } = setup({ fetchAudio });
    const [a, b] = [track(1), track(2)];

    loader.setPlaying(a);
    await settle();
    expect(signals).toHaveLength(1);
    loader.setPlaying(b);
    expect(signals[0]!.aborted).toBe(true);
    await settle();

    expect(loader.get(a).status).toBe('none');
    expect(fetchAudio.mock.calls.map(([url]) => url)).toEqual([a.streamUrl, b.streamUrl]);
    expect(loader.get(b).status).toBe('loading');
    loader.setEnabled(false);
    expect(signals[1]!.aborted).toBe(true);
  });

  it('refreshes a stale stream link before downloading', async () => {
    const { loader, deps } = setup();
    const t = track(1, { streamFetchedAt: 0 });
    loader.setPlaying(t);
    await settle();
    expect(deps.refreshStream).toHaveBeenCalledWith(t, false);
    expect(loader.get(t).status).toBe('ready');
  });

  it('retries a failed download only after a while', async () => {
    const fetchAudio = vi.fn(async () => ({ error: 'HTTP 500' }));
    const { loader } = setup({ fetchAudio });
    const t = track(1);

    loader.setPlaying(t);
    await settle();
    expect(loader.get(t).status).toBe('error');
    loader.setPlaying(t);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    try {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
      loader.setPlaying(t);
      await settle();
      expect(fetchAudio).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('gives up on a track when the stream permission is missing', async () => {
    const { loader } = setup({ fetchAudio: vi.fn(async () => ({ noPermission: true })) });
    const t = track(1);
    loader.setPlaying(t);
    await settle();
    expect(loader.get(t).status).toBe('unavailable');
  });

  it('downloads nothing while off, and drops a download that was running when turned off', async () => {
    const signals: AbortSignal[] = [];
    const fetchAudio = vi.fn((_url: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<{ error: string }>((resolve) => signal.addEventListener('abort', () => resolve({ error: 'Cancelled' })));
    });
    const { loader, written } = setup({ fetchAudio });
    const t = track(1);

    loader.setPlaying(t);
    await settle();
    loader.setEnabled(false);
    expect(signals[0]!.aborted).toBe(true);
    await settle();
    expect(loader.get(t).status).toBe('none');
    expect(written.size).toBe(0);

    loader.setPlaying(track(2));
    loader.prefetch([track(3)]);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a track that cannot be streamed', () => {
    const { loader, deps } = setup();
    const t = track(1, { unplayable: true });
    loader.setPlaying(t);
    expect(loader.get(t).status).toBe('unavailable');
    expect(deps.read).not.toHaveBeenCalled();
  });
  it('loads upcoming tracks after the playing one, as bulk downloads', async () => {
    const { loader, deps } = setup();
    const [a, b, c] = [track(1), track(2, { streamFetchedAt: 0 }), track(3)];

    loader.setPlaying(a);
    loader.prefetch([b, c]);
    await settle();

    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url, , bulk]) => [url, bulk])).toEqual([
      [a.streamUrl, false],
      [b.streamUrl, true],
      [c.streamUrl, true],
    ]);
    expect(deps.refreshStream).toHaveBeenCalledWith(b, true);
    expect(loader.get(b).status).toBe('ready');
    expect(loader.get(c).status).toBe('ready');

    // Already loaded: playing them downloads nothing more.
    loader.setPlaying(b);
    loader.prefetch([c]);
    await settle();
    expect(deps.fetchAudio).toHaveBeenCalledTimes(3);
  });

  it('stops loading ahead for the playing track, and for a track no longer upcoming', async () => {
    const signals = new Map<string, AbortSignal>();
    const fetchAudio = vi.fn((url: string, signal: AbortSignal) => {
      signals.set(url, signal);
      return new Promise<{ error: string }>((resolve) => signal.addEventListener('abort', () => resolve({ error: 'Cancelled' })));
    });
    const { loader } = setup({ fetchAudio });
    const [a, b, c, d] = [track(1), track(2), track(3), track(4)];

    loader.prefetch([b, c]);
    await settle();
    expect([...signals.keys()]).toEqual([b.streamUrl]);

    // Playing another track goes first; what was loading ahead is dropped.
    loader.setPlaying(a);
    expect(signals.get(b.streamUrl!)!.aborted).toBe(true);
    await settle();
    expect(loader.get(b).status).toBe('none');
    expect(loader.get(a).status).toBe('loading');

    const second = setup({ fetchAudio }).loader;
    second.prefetch([c]);
    await settle();
    expect(second.get(c).status).toBe('loading');
    second.prefetch([d]);
    expect(signals.get(c.streamUrl!)!.aborted).toBe(true);
    await settle();
    expect(second.get(c).status).toBe('none');
    expect(second.get(d).status).toBe('loading');
  });

  it('keeps loading a track ahead when it starts playing, with its later steps no longer bulk', async () => {
    let finishRefresh!: () => void;
    const refreshStream = vi.fn((t: PlaylistTrack) => new Promise<void>((resolve) => {
      finishRefresh = () => { t.streamFetchedAt = Date.now(); resolve(); };
    }));
    const { loader, deps } = setup({ refreshStream });
    const [b, c] = [track(2, { streamFetchedAt: 0 }), track(3)];

    loader.prefetch([b, c]);
    await settle();
    expect(refreshStream).toHaveBeenCalledWith(b, true);
    loader.setPlaying(b);
    // The player then loads ahead from the new track.
    loader.prefetch([c]);
    finishRefresh();
    await settle();

    expect(refreshStream).toHaveBeenCalledTimes(1);
    expect(loader.get(b).status).toBe('ready');
    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url, , bulk]) => [url, bulk])).toEqual([
      [b.streamUrl, false],
      [c.streamUrl, true],
    ]);
  });

  function controlledDecode() {
    const finishers: (() => void)[] = [];
    let decoding = 0;
    let mostAtOnce = 0;
    const decode = vi.fn(() => {
      decoding++;
      mostAtOnce = Math.max(mostAtOnce, decoding);
      return new Promise<Float32Array[]>((resolve) => finishers.push(() => { decoding--; resolve([new Float32Array(8000).fill(0.5)]); }));
    });
    return { decode, finish: (i: number) => finishers[i]!(), mostAtOnce: () => mostAtOnce };
  }

  it('lets a decode finish and keeps its waveform when another track plays', async () => {
    const { decode, finish, mostAtOnce } = controlledDecode();
    const { loader, deps } = setup({ decode });
    const [a, b, c] = [track(1), track(2), track(3)];

    loader.prefetch([b]);
    await settle();
    loader.setPlaying(a);
    await settle();
    // Nothing else starts while the decode runs, and the playing track shows
    // it is on its way.
    expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
    expect(loader.get(a).status).toBe('loading');
    finish(0);
    await settle();
    expect(loader.get(b).status).toBe('ready');
    loader.setPlaying(c);
    await settle();
    finish(1);
    await settle();
    finish(2);
    await settle();

    expect(mostAtOnce()).toBe(1);
    expect(loader.get(a).status).toBe('ready');
    expect(loader.get(c).status).toBe('ready');
    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url]) => url)).toEqual([b.streamUrl, a.streamUrl, c.streamUrl]);
  });

  it('finishes a decode when turned off, keeping its waveform, before loading anything else', async () => {
    const { decode, finish } = controlledDecode();
    const { loader, deps, written } = setup({ decode });
    const [a, b] = [track(1), track(2)];

    loader.setPlaying(a);
    await settle();
    loader.setEnabled(false);
    loader.setEnabled(true);
    loader.setPlaying(b);
    await settle();
    expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
    finish(0);
    await settle();
    expect(loader.get(a).status).toBe('ready');
    expect(written.has(trackWaveformKey(a))).toBe(true);
    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url]) => url)).toEqual([a.streamUrl, b.streamUrl]);
  });

  it('decodes a track once when turned off and on during its decode', async () => {
    const { decode, finish } = controlledDecode();
    const { loader, deps } = setup({ decode });
    const a = track(1);

    loader.setPlaying(a);
    await settle();
    loader.setEnabled(false);
    loader.setEnabled(true);
    finish(0);
    await settle();
    expect(loader.get(a).status).toBe('ready');
    expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('loads the playing track and the ones ahead when turned on', async () => {
    const { loader, deps } = setup();
    const [a, b] = [track(1), track(2)];
    loader.setEnabled(false);
    loader.setPlaying(a);
    loader.prefetch([b]);
    await settle();
    expect(deps.fetchAudio).not.toHaveBeenCalled();

    loader.setEnabled(true);
    await settle();
    expect(vi.mocked(deps.fetchAudio).mock.calls.map(([url, , bulk]) => [url, bulk])).toEqual([
      [a.streamUrl, false],
      [b.streamUrl, true],
    ]);
  });

  it('gives up on a decode that never finishes, so later loads still run', async () => {
    vi.useFakeTimers();
    try {
      const decode = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue([new Float32Array(8000).fill(0.5)]);
      const { loader } = setup({ decode });
      const [a, b] = [track(1), track(2)];

      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(0);
      loader.setPlaying(b);
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.get(b).status).toBe('loading');
      await vi.advanceTimersByTimeAsync(WAVEFORM_DECODE_TIMEOUT_MS);
      // Still decoding, as far as anyone can tell.
      expect(loader.get(a).status).toBe('loading');
      expect(loader.get(b).status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads a track ahead again after a retry of the playing track interrupted it, and after a jump only the one that was loading', async () => {
    const calls: { url: string; finish: () => void; fail: () => void }[] = [];
    const fetchAudio = vi.fn((url: string, signal: AbortSignal) =>
      new Promise<{ audioBase64?: string; error?: string }>((resolve) => {
        calls.push({ url, finish: () => resolve({ audioBase64: bytesToBase64(new Uint8Array([1])) }), fail: () => resolve({ error: 'HTTP 500' }) });
        signal.addEventListener('abort', () => resolve({ error: 'Cancelled' }));
      })
    );
    const { loader } = setup({ fetchAudio });
    const [a, b, c, x] = [track(1), track(2), track(3), track(9)];
    try {
      loader.setPlaying(a);
      await settle();
      calls[0]!.fail();
      await settle();
      loader.prefetch([b, c]);
      await settle();
      expect(calls.map(({ url }) => url)).toEqual([a.streamUrl, b.streamUrl]);

      // The playing track's retry interrupts b, which loads again after it.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
      loader.setPlaying(a);
      await settle();
      calls[2]!.finish();
      await settle();
      expect(calls.map(({ url }) => url)).toEqual([a.streamUrl, b.streamUrl, a.streamUrl, b.streamUrl]);

      // Jumping elsewhere keeps only b, which was loading, until the player
      // sends what is upcoming from there; c is dropped.
      loader.setPlaying(x);
      await settle();
      calls[4]!.finish();
      await settle();
      calls[5]!.finish();
      await settle();
      expect(calls.map(({ url }) => url)).toEqual([a.streamUrl, b.streamUrl, a.streamUrl, b.streamUrl, x.streamUrl, b.streamUrl]);
      expect(loader.get(c).status).toBe('none');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the wait before retrying a track ahead that failed as the playing track is retried', async () => {
    const pending = new Map<string, () => void>();
    const fetchAudio = vi.fn((url: string) => new Promise<{ error: string }>((resolve) => pending.set(url, () => resolve({ error: 'HTTP 500' }))));
    const { loader } = setup({ fetchAudio });
    const [playing, c] = [track(1), track(3)];
    try {
      loader.setPlaying(playing);
      await settle();
      pending.get(playing.streamUrl!)!();
      await settle();
      loader.prefetch([c]);
      await settle();
      // The playing track's wait is over by the time c fails, so it is tried
      // again then, which must not wipe c's failure.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
      pending.get(c.streamUrl!)!();
      await settle();
      expect(loader.get(c).status).toBe('error');
      expect(fetchAudio.mock.calls.map(([url]) => url)).toEqual([playing.streamUrl, c.streamUrl, playing.streamUrl]);
      loader.prefetch([c]);
      await settle();
      expect(fetchAudio.mock.calls.filter(([url]) => url === c.streamUrl)).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  function controlledFetch() {
    const calls: { url: string; bulk: boolean; signal: AbortSignal; requestId: string; finish: () => void; fail: () => void }[] = [];
    const fetchAudio = vi.fn((url: string, signal: AbortSignal, bulk: boolean, requestId: string) =>
      new Promise<{ audioBase64?: string; error?: string }>((resolve) => {
        calls.push({ url, bulk, signal, requestId, finish: () => resolve({ audioBase64: bytesToBase64(new Uint8Array([1])) }), fail: () => resolve({ error: 'HTTP 500' }) });
        signal.addEventListener('abort', () => resolve({ error: 'Cancelled' }));
      })
    );
    return { calls, fetchAudio, urls: () => calls.map(({ url }) => url) };
  }

  it('keeps loading ahead the track after next when the next one starts', async () => {
    const { calls, fetchAudio, urls } = controlledFetch();
    const { loader } = setup({ fetchAudio });
    const [a, b, c, d] = [track(1), track(2), track(3), track(4)];

    loader.setPlaying(a);
    loader.prefetch([b, c]);
    await settle();
    calls[0]!.finish();
    await settle();
    calls[1]!.finish();
    await settle();
    expect(urls()).toEqual([a.streamUrl, b.streamUrl, c.streamUrl]);

    // a ends and b plays, then the player sends what follows b.
    loader.setPlaying(b);
    loader.prefetch([c, d]);
    await settle();
    expect(calls[2]!.signal.aborted).toBe(false);
    calls[2]!.finish();
    await settle();
    expect(urls()).toEqual([a.streamUrl, b.streamUrl, c.streamUrl, d.streamUrl]);
  });

  it('moves a track loading ahead up the download queue when it starts playing', async () => {
    const { calls, fetchAudio } = controlledFetch();
    const { loader, deps } = setup({ fetchAudio });
    const [b, c] = [track(2), track(3)];

    loader.prefetch([b, c]);
    await settle();
    expect(calls[0]!.bulk).toBe(true);
    loader.setPlaying(b);
    expect(deps.promoteAudio).toHaveBeenCalledWith(calls[0]!.requestId);
    expect(calls[0]!.signal.aborted).toBe(false);
    loader.setPlaying(b);
    expect(deps.promoteAudio).toHaveBeenCalledTimes(1);
  });

  it('keeps loading a track ahead when an earlier one becomes due for a retry', async () => {
    const { calls, fetchAudio, urls } = controlledFetch();
    const { loader } = setup({ fetchAudio });
    const [b, c] = [track(2), track(3)];
    try {
      loader.prefetch([b, c]);
      await settle();
      calls[0]!.fail();
      await settle();
      expect(urls()).toEqual([b.streamUrl, c.streamUrl]);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
      loader.prefetch([b, c]);
      await settle();
      expect(calls[1]!.signal.aborted).toBe(false);
      calls[1]!.finish();
      await settle();
      expect(urls()).toEqual([b.streamUrl, c.streamUrl, b.streamUrl]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('starts nothing new while paused, finishing what is loading', async () => {
    const { calls, fetchAudio, urls } = controlledFetch();
    const { loader } = setup({ fetchAudio });
    const [a, b, c] = [track(1), track(2), track(3)];

    loader.setPlaying(a);
    loader.prefetch([b, c]);
    await settle();
    loader.pause();
    calls[0]!.finish();
    await settle();
    expect(loader.get(a).status).toBe('ready');
    expect(urls()).toEqual([a.streamUrl]);

    loader.setPlaying(a);
    await settle();
    expect(urls()).toEqual([a.streamUrl, b.streamUrl]);
  });

  it('downloads nothing when turned on while paused', async () => {
    const { loader, deps } = setup();
    const [a, b] = [track(1), track(2)];
    loader.setEnabled(false);
    loader.setPlaying(a);
    loader.prefetch([b]);
    loader.pause();

    loader.setEnabled(true);
    await settle();
    expect(deps.fetchAudio).not.toHaveBeenCalled();
    loader.setPlaying(a);
    await settle();
    expect(deps.fetchAudio).toHaveBeenCalledTimes(2);
  });

  it('keeps the waveform of a decode that finishes after timing out, without decoding it again meanwhile', async () => {
    vi.useFakeTimers();
    try {
      let finishLate!: () => void;
      const decode = vi.fn()
        .mockReturnValueOnce(new Promise<Float32Array[]>((resolve) => { finishLate = () => resolve([new Float32Array(8000).fill(0.5)]); }))
        .mockResolvedValue([new Float32Array(8000).fill(0.5)]);
      const { loader, written } = setup({ decode });
      const a = track(1);

      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(WAVEFORM_DECODE_TIMEOUT_MS);
      expect(loader.get(a).status).toBe('loading');
      await vi.advanceTimersByTimeAsync(WAVEFORM_RETRY_AFTER_MS);
      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(0);
      expect(decode).toHaveBeenCalledTimes(1);

      finishLate();
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.get(a).status).toBe('ready');
      expect(written.has(trackWaveformKey(a))).toBe(true);
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits before trying again a decode that fails after timing out', async () => {
    vi.useFakeTimers();
    try {
      let failLate!: () => void;
      const decode = vi.fn()
        .mockReturnValueOnce(new Promise<Float32Array[]>((_, reject) => { failLate = () => reject(new Error('Bad audio')); }))
        .mockResolvedValue([new Float32Array(8000).fill(0.5)]);
      const { loader, deps } = setup({ decode });
      const a = track(1);

      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(WAVEFORM_DECODE_TIMEOUT_MS + WAVEFORM_RETRY_AFTER_MS);
      failLate();
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.get(a).status).toBe('error');
      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(WAVEFORM_RETRY_AFTER_MS);
      loader.setPlaying(a);
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.fetchAudio).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a load ahead finish when paused with the playing track due for a retry', async () => {
    const { calls, fetchAudio } = controlledFetch();
    const { loader } = setup({ fetchAudio });
    const [a, b] = [track(1), track(2)];
    try {
      loader.setPlaying(a);
      await settle();
      calls[0]!.fail();
      await settle();
      loader.prefetch([b]);
      await settle();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WAVEFORM_RETRY_AFTER_MS + 1);
      loader.pause();
      expect(calls[1]!.signal.aborted).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the download loading ahead after a jump elsewhere, until the player sends what follows', async () => {
    const { calls, fetchAudio, urls } = controlledFetch();
    const { loader } = setup({ fetchAudio, read: vi.fn(async (key: string) => (key === trackWaveformKey(track(9)) ? { peaks: new Float32Array([1]), seconds: 60 } : null)) });
    const [a, b, c, x] = [track(1), track(2), track(3), track(9)];

    loader.setPlaying(a);
    await settle();
    calls[0]!.finish();
    await settle();
    loader.prefetch([b, c]);
    await settle();
    // x's waveform is stored, so nothing is held up and b keeps loading.
    await loader.loadStored(x);
    loader.setPlaying(x);
    await settle();
    expect(loader.get(x).status).toBe('ready');
    expect(calls[1]!.signal.aborted).toBe(false);
    loader.prefetch([a, b]);
    expect(calls[1]!.signal.aborted).toBe(false);
    // c wasn't kept: it isn't loaded once b is done unless sent again.
    calls[1]!.finish();
    await settle();
    expect(urls()).toEqual([a.streamUrl, b.streamUrl]);
  });

  it('shows no spinner for the playing track while paused', async () => {
    const { decode, finish } = controlledDecode();
    const { loader } = setup({ decode });
    const [b, c] = [track(2), track(3)];

    loader.prefetch([b]);
    await settle();
    loader.setPlaying(c);
    expect(loader.get(c).status).toBe('loading');
    loader.pause();
    expect(loader.get(c).status).toBe('none');
    finish(0);
    await settle();
    expect(loader.get(c).status).toBe('none');
    loader.setPlaying(c);
    expect(loader.get(c).status).toBe('loading');

    const off = setup().loader;
    off.setEnabled(false);
    off.setPlaying(c);
    off.pause();
    off.setEnabled(true);
    expect(off.get(c).status).toBe('none');
  });

  it('is safe with a listener that says which track plays on every change', async () => {
    const pending: AbortSignal[] = [];
    const fetchAudio = vi.fn((_url: string, signal: AbortSignal) => {
      pending.push(signal);
      return new Promise<{ error: string }>(() => {});
    });
    const { loader } = setup({ fetchAudio });
    const [playing, ahead] = [track(1), track(2)];
    loader.onChange(() => loader.setPlaying(playing));

    loader.setPlaying(playing);
    loader.prefetch([ahead]);
    await settle();

    expect(fetchAudio.mock.calls.map(([url]) => url)).toEqual([playing.streamUrl]);
    expect(loader.get(ahead).status).toBe('none');
    loader.setEnabled(false);
    expect(pending.every((signal) => signal.aborted)).toBe(true);
  });

  it('starts the playing track without waiting for a stopped download to answer', async () => {
    // The background only answers a cancelled bulk download once it gets a slot.
    const fetchAudio = vi.fn((_url: string, _signal: AbortSignal) => new Promise<{ error: string }>(() => {}));
    const { loader } = setup({ fetchAudio });
    const [playing, ahead] = [track(1), track(2)];

    loader.prefetch([ahead]);
    await settle();
    loader.setPlaying(playing);
    await settle();

    expect(fetchAudio.mock.calls.map(([url]) => url)).toEqual([ahead.streamUrl, playing.streamUrl]);
  });

  it('loads ahead again a track whose load ahead was stopped', async () => {
    const fetchAudio = vi.fn((_url: string, signal: AbortSignal) =>
      new Promise<{ error: string }>((resolve) => signal.addEventListener('abort', () => setTimeout(() => resolve({ error: 'Cancelled' }), 5))));
    const { loader } = setup({ fetchAudio });
    const [a, b] = [track(1), track(2)];

    loader.prefetch([a]);
    await settle();
    loader.prefetch([b]);
    loader.prefetch([a]);
    await settle();

    // `b` is stopped before its download starts, and `a` loads again though its
    // stopped download hasn't answered yet.
    expect(fetchAudio.mock.calls.map(([url]) => url)).toEqual([a.streamUrl, a.streamUrl]);
    expect(loader.get(a).status).toBe('loading');
  });

  it('tries a track again when it plays after its load ahead failed', async () => {
    const fetchAudio = vi.fn(async (_url: string, _signal: AbortSignal, _bulk: boolean) => ({ error: 'HTTP 500' }));
    const { loader } = setup({ fetchAudio });
    const t = track(1);

    loader.prefetch([t]);
    await settle();
    expect(loader.get(t).status).toBe('error');
    loader.prefetch([t]);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    loader.setPlaying(t);
    await settle();
    expect(fetchAudio.mock.calls.map(([, , bulk]) => bulk)).toEqual([true, false]);
    // Failed while playing: waits before trying again.
    loader.setPlaying(t);
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(2);
  });
});
