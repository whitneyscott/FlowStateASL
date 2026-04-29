/**
 * Map `items` with at most `limit` concurrent in-flight `fn` calls. Preserves result order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const cap = Math.max(1, Math.floor(limit));
  const out: R[] = new Array(n);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  const workers = Math.min(cap, n);
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return out;
}
