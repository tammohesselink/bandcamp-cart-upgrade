import { describe, it, expect, vi } from 'vitest';
import { ERROR_RETRY_AFTER_MS, TempoAnalyzer, type TempoAnalyzerDeps } from '../src/tempo-analyzer';
import { trackTempoKey, type StoredTempo } from '../src/tempo-store';
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

function setup(overrides: Partial<TempoAnalyzerDeps> = {}, stored = new Map<string, StoredTempo>()) {
  const written = new Map<string, StoredTempo>();
  const deps: TempoAnalyzerDeps = {
    refreshStream: vi.fn(async (t: PlaylistTrack) => { t.streamFetchedAt = Date.now(); }),
    fetchAudio: vi.fn(async () => ({ audioBase64: bytesToBase64(new Uint8Array([1, 2, 3])) })),
    decode: vi.fn(async () => new Float32Array(10)),
    analyse: vi.fn(() => ({ bpm: 128, confidence: 0.9 })),
    read: vi.fn(async (keys: string[]) => new Map([...stored].filter(([key]) => keys.includes(key)))),
    write: vi.fn((key: string, tempo: StoredTempo) => { written.set(key, tempo); }),
    ...overrides,
  };
  const analyzer = new TempoAnalyzer(deps);
  analyzer.setEnabled(true);
  return { analyzer, deps, written };
}

describe('TempoAnalyzer', () => {
  it('detects and stores the BPM of a track', async () => {
    const { analyzer, written } = setup();
    const t = track(1);

    analyzer.analyse(t);
    expect(analyzer.get(t).status).toBe('analyzing');
    await settle();

    expect(analyzer.get(t)).toMatchObject({ bpm: 128, source: 'detected', status: 'none' });
    expect(written.get(trackTempoKey(t))).toMatchObject({ bpm: 128, confidence: 0.9 });
  });

  it('uses a stored BPM without downloading the track', async () => {
    const t = track(1);
    const stored = new Map([[trackTempoKey(t), { bpm: 140, confidence: 1, source: 'manual' as const, savedAt: 0 }]]);
    const { analyzer, deps } = setup({}, stored);

    await analyzer.load([t]);
    analyzer.analyse(t);
    await settle();

    expect(analyzer.get(t).bpm).toBe(140);
    expect(deps.fetchAudio).not.toHaveBeenCalled();
  });

  it('detects again when forced, replacing a hand-set BPM', async () => {
    const { analyzer } = setup();
    const t = track(1);
    analyzer.setBpm(t, 64);

    analyzer.analyse(t, { force: true });
    await settle();

    expect(analyzer.get(t)).toMatchObject({ bpm: 128, source: 'detected' });
  });

  it('refreshes an expired stream link first', async () => {
    const { analyzer, deps } = setup();
    const t = track(1, { streamFetchedAt: Date.now() - 2 * 60 * 60 * 1000 });

    analyzer.analyse(t);
    await settle();

    expect(deps.refreshStream).toHaveBeenCalledWith(t, false);
    expect(analyzer.get(t).bpm).toBe(128);
  });

  it('does nothing while turned off', async () => {
    const { analyzer, deps } = setup();
    analyzer.setEnabled(false);
    const t = track(1);

    analyzer.analyse(t);
    await settle();

    expect(deps.fetchAudio).not.toHaveBeenCalled();
    expect(analyzer.get(t).status).toBe('no-permission');
  });

  it('stops when the stream permission is missing', async () => {
    const { analyzer, deps } = setup({ fetchAudio: vi.fn(async () => ({ noPermission: true })) });
    const tracks = [1, 2, 3, 4].map((n) => track(n));

    for (const t of tracks) analyzer.analyse(t, { bulk: true });
    await settle();

    // The first two were already running side by side.
    expect(deps.fetchAudio).toHaveBeenCalledTimes(2);
    expect(tracks.map((t) => analyzer.get(t).status)).toEqual(Array(4).fill('no-permission'));
  });

  it('marks a track without a beat as failed and does not retry it on its own', async () => {
    const { analyzer, deps } = setup({ analyse: vi.fn(() => null) });
    const t = track(1);

    analyzer.analyse(t);
    await settle();
    analyzer.analyse(t);
    await settle();

    expect(analyzer.get(t).status).toBe('failed');
    expect(deps.fetchAudio).toHaveBeenCalledTimes(1);
  });

  it('puts a track someone waits on ahead of a playlist-wide detection', async () => {
    const order: string[] = [];
    const { analyzer } = setup({
      fetchAudio: vi.fn(async (url: string) => {
        order.push(url.split('/').pop()!);
        return { audioBase64: bytesToBase64(new Uint8Array([1])) };
      }),
    });

    for (const n of [1, 2, 3, 4]) analyzer.analyse(track(n), { bulk: true });
    analyzer.analyse(track(9));
    await settle();

    expect(order.slice(0, 3)).toEqual(['track-1', 'track-2', 'track-9']);
  });

});

describe('TempoAnalyzer keeping BPMs the user set', () => {
  // A fetch that waits until the test lets it go.
  function heldFetch() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchAudio = vi.fn(async () => {
      await held;
      return { audioBase64: bytesToBase64(new Uint8Array([1])) };
    });
    return { fetchAudio, release: () => release() };
  }

  it('keeps a BPM set while detection was running', async () => {
    const { fetchAudio, release } = heldFetch();
    const { analyzer, written } = setup({ fetchAudio });
    const t = track(1);

    analyzer.analyse(t);
    await settle();
    analyzer.setBpm(t, 100);
    release();
    await settle();

    expect(analyzer.get(t)).toMatchObject({ bpm: 100, source: 'manual' });
    expect(written.get(trackTempoKey(t))).toMatchObject({ bpm: 100, source: 'manual' });
  });

  it('drops a waiting detection when the BPM is set', async () => {
    const { fetchAudio, release } = heldFetch();
    const { analyzer, deps } = setup({ fetchAudio });
    const [a, b, c] = [track(1), track(2), track(3)];
    for (const t of [a, b, c]) analyzer.analyse(t, { bulk: true });
    await settle();

    analyzer.setBpm(c, 90);
    release();
    await settle();

    expect(deps.fetchAudio).toHaveBeenCalledTimes(2);
    expect(analyzer.get(c)).toMatchObject({ bpm: 90, source: 'manual' });
  });

  it('uses a saved BPM that was still being loaded instead of downloading', async () => {
    const t = track(1);
    const saved = new Map([[trackTempoKey(t), { bpm: 95, confidence: 1, source: 'manual' as const, savedAt: 0 }]]);
    const { analyzer, deps } = setup({}, saved);

    // No load() first, as when a track plays before its playlist's read returns.
    analyzer.analyse(t);
    await settle();

    expect(deps.fetchAudio).not.toHaveBeenCalled();
    expect(analyzer.get(t).bpm).toBe(95);
  });
});

describe('TempoAnalyzer failures', () => {
  it('retries a track whose download failed, after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetchAudio = vi.fn(async () => ({ error: 'HTTP 503' }));
      const { analyzer } = setup({ fetchAudio });
      const t = track(1);

      analyzer.analyse(t);
      await settle();
      expect(analyzer.get(t).status).toBe('error');

      analyzer.analyse(t);
      await settle();
      expect(fetchAudio).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + ERROR_RETRY_AFTER_MS + 1);
      analyzer.analyse(t);
      await settle();
      expect(fetchAudio).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the result of a detection still running when turned off', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { analyzer, deps, written } = setup({
      fetchAudio: vi.fn(async () => {
        await held;
        return { audioBase64: bytesToBase64(new Uint8Array([1])) };
      }),
    });
    const t = track(1);

    analyzer.analyse(t);
    await settle();
    analyzer.setEnabled(false);
    release();
    await settle();

    expect(deps.decode).not.toHaveBeenCalled();
    expect(written.size).toBe(0);
    expect(analyzer.get(t).bpm).toBeNull();
  });
});

describe('trackTempoKey', () => {
  it('tells apart tracks of a release that share its page', () => {
    const release = 'https://solardrift.bandcamp.com/album/echoes';
    expect(trackTempoKey({ trackId: null, pageUrl: release, trackTitle: 'A' }))
      .not.toBe(trackTempoKey({ trackId: null, pageUrl: release, trackTitle: 'B' }));
  });

  it('uses the track ID when there is one', () => {
    expect(trackTempoKey({ trackId: 5, pageUrl: 'https://a.bandcamp.com/track/x', trackTitle: 'X' }))
      .toBe(trackTempoKey({ trackId: 5, pageUrl: 'https://a.bandcamp.com/track/y', trackTitle: 'Y' }));
  });
});
