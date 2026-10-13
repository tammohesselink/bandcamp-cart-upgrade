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
