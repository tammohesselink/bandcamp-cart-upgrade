// Concurrent calls for the same key share one in-flight promise until it settles.
export function dedupeInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = start().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Runs `task` over `items` with at most `limit` running at once. Results keep
// the input order; `onSettled` fires as each one finishes. After a task
// rejects no new tasks start, and the rejection is raised only once the
// running ones have finished, so `onSettled` never fires after it.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  onSettled?: (result: R, item: T) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try {
        const result = await task(items[index]!);
        results[index] = result;
        if (!failure) onSettled?.(result, items[index]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

export type Priority = 'interactive' | 'bulk';

export interface Limiter {
  // `id` lets promote() find the task while it is queued.
  <R>(priority: Priority, task: () => Promise<R>, id?: string): Promise<R>;
  // Moves a queued bulk task to the back of the interactive queue, e.g. a
  // download that someone is now waiting on. Does nothing once it has started.
  promote(id: string): void;
}

// Caps how many tasks run at once across every caller. Interactive tasks start
// before any queued bulk task.
export function createLimiter(limit: number): Limiter {
  let running = 0;
  type Queued = { id?: string; start: () => void };
  const queues: Record<Priority, Queued[]> = { interactive: [], bulk: [] };
  const startNext = () => {
    if (running >= limit) return;
    const next = queues.interactive.shift() ?? queues.bulk.shift();
    if (!next) return;
    running++;
    next.start();
  };
  const limiter = <R>(priority: Priority, task: () => Promise<R>, id?: string) =>
    new Promise<R>((resolve, reject) => {
      queues[priority].push({
        id,
        start: () => {
          task()
            .then(resolve, reject)
            .finally(() => {
              running--;
              startNext();
            });
        },
      });
      startNext();
    });
  limiter.promote = (id: string) => {
    const index = queues.bulk.findIndex((queued) => queued.id === id);
    if (index !== -1) queues.interactive.push(...queues.bulk.splice(index, 1));
  };
  return limiter;
}
