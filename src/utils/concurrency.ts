/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once. Order-
 * preserving (results[i] corresponds to items[i] regardless of completion order),
 * pull-based (a worker that finishes early pulls the next unclaimed item instead of
 * waiting for the others in its "batch" — a slow item never stalls the rest), and one
 * item's rejection doesn't stop the others from running (mirrors Promise.allSettled's
 * result shape rather than throwing).
 *
 * No dependency: this is the "20-line pool" the task asked for instead of pulling in
 * p-limit.
 */
export default async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  // Synchronous claim-and-advance: safe without a lock because JS never interleaves
  // two workers between this read and this write — the next `await` is what yields.
  function claimNext(): number {
    if (nextIndex >= items.length) {
      return -1;
    }
    const index = nextIndex;
    nextIndex += 1;
    return index;
  }

  async function worker(): Promise<void> {
    let index = claimNext();
    while (index !== -1) {
      try {
        const value = await fn(items[index], index);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      index = claimNext();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
