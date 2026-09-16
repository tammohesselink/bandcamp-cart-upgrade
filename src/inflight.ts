// Coalesces concurrent calls for the same key into a single in-flight promise,
// so multiple callers (e.g. several browser tabs racing on a cache miss) share
// one underlying operation instead of each starting their own.
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
