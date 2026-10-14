import { describe, it, expect } from 'vitest';
import { dedupeInFlight, mapWithConcurrency } from '../src/inflight';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('dedupeInFlight', () => {
  it('invokes start only once for concurrent calls with the same key', async () => {
    const inFlight = new Map<string, Promise<string>>();
    const pending = deferred<string>();
    let startCalls = 0;
    const start = () => {
      startCalls++;
      return pending.promise;
    };

    const first = dedupeInFlight(inFlight, 'url-a', start);
    const second = dedupeInFlight(inFlight, 'url-a', start);

    pending.resolve('result');
    expect(await first).toBe('result');
    expect(await second).toBe('result');
    expect(startCalls).toBe(1);
  });

  it('invokes start again for a later call after the promise has settled', async () => {
    const inFlight = new Map<string, Promise<string>>();
    let startCalls = 0;
    const start = () => {
      startCalls++;
      return Promise.resolve(`result-${startCalls}`);
    };

    expect(await dedupeInFlight(inFlight, 'url-a', start)).toBe('result-1');
    expect(await dedupeInFlight(inFlight, 'url-a', start)).toBe('result-2');
    expect(startCalls).toBe(2);
  });

  it('invokes start independently for different keys', async () => {
    const inFlight = new Map<string, Promise<string>>();
    let startCalls = 0;
    const start = () => {
      startCalls++;
      return Promise.resolve('result');
    };

    await Promise.all([
      dedupeInFlight(inFlight, 'url-a', start),
      dedupeInFlight(inFlight, 'url-b', start),
    ]);

    expect(startCalls).toBe(2);
  });

  it('clears the map entry when start rejects, so a later call retries', async () => {
    const inFlight = new Map<string, Promise<string>>();
    let startCalls = 0;
    const start = () => {
      startCalls++;
      return startCalls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('recovered');
    };

    await expect(dedupeInFlight(inFlight, 'url-a', start)).rejects.toThrow('boom');
    expect(inFlight.has('url-a')).toBe(false);
    expect(await dedupeInFlight(inFlight, 'url-a', start)).toBe('recovered');
    expect(startCalls).toBe(2);
  });
});

describe('mapWithConcurrency', () => {
  it.each([
    { name: 'fewer items than the limit', itemCount: 2, limit: 4, expectedPeak: 2 },
    { name: 'more items than the limit', itemCount: 10, limit: 4, expectedPeak: 4 },
    { name: 'a limit of one', itemCount: 3, limit: 1, expectedPeak: 1 },
    { name: 'no items', itemCount: 0, limit: 4, expectedPeak: 0 },
  ])('keeps input order and never exceeds the limit with $name', async ({ itemCount, limit, expectedPeak }) => {
    const items = Array.from({ length: itemCount }, (_, i) => i);
    let running = 0;
    let peak = 0;
    const settled: number[] = [];

    const results = await mapWithConcurrency(
      items,
      limit,
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        // Later items finish first, so completion order differs from input order.
        await new Promise((r) => setTimeout(r, (itemCount - n) * 2));
        running--;
        return n * 10;
      },
      (_result, n) => settled.push(n)
    );

    expect(results).toEqual(items.map((n) => n * 10));
    expect(peak).toBe(expectedPeak);
    expect([...settled].sort((a, b) => a - b)).toEqual(items);
  });

  it('starts the next item as soon as one finishes instead of waiting for the whole batch', async () => {
    const slow = deferred<string>();
    const started: string[] = [];

    const run = mapWithConcurrency(['slow', 'fast', 'third'], 2, (item) => {
      started.push(item);
      return item === 'slow' ? slow.promise : Promise.resolve(item);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['slow', 'fast', 'third']);

    slow.resolve('slow');
    expect(await run).toEqual(['slow', 'fast', 'third']);
  });
});
