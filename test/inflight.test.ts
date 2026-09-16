import { describe, it, expect } from 'vitest';
import { dedupeInFlight } from '../src/inflight';

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
