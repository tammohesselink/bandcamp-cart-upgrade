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

// Caps how many tasks run at once across every caller. Interactive tasks start
// before any queued bulk task.
export function createLimiter(limit: number): <R>(priority: Priority, task: () => Promise<R>) => Promise<R> {
  let running = 0;
  const queues: Record<Priority, Array<() => void>> = { interactive: [], bulk: [] };
  const startNext = () => {
    if (running >= limit) return;
    const start = queues.interactive.shift() ?? queues.bulk.shift();
    if (!start) return;
    running++;
    start();
  };
  return (priority, task) =>
    new Promise((resolve, reject) => {
      queues[priority].push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            startNext();
          });
      });
      startNext();
    });
}
