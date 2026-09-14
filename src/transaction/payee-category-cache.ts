import { UnifiedResponse } from '../types';

/**
 * Caches the LLM's categorization response per key for the lifetime of a single
 * classification run. Keyed by Actual's own resolved payee id when one exists
 * (transaction.payee — always available, always correct: Actual already deduplicates
 * bank transactions into a stable payee record) and, only when a caller opts into it,
 * a normalized-text fallback key for transactions with no resolved payee — see
 * deriveFallbackDedupKey in dedup-key.ts. Either way, a repeat key has, in practice,
 * already been judged by the model once — asking again just repeats the same full
 * prompt (categories + rules) for the same answer.
 *
 * Stores in-flight Promises, not resolved values: two calls for the same key that
 * overlap in time (relevant once Phase 3 adds concurrency) share the one underlying
 * LLM request instead of racing into two. A rejected request is evicted immediately
 * so it doesn't poison every later transaction for that key with the same permanent
 * failure — the next caller gets a fresh attempt.
 *
 * Scoped to one run only: categories and rules can change between scheduled runs, so
 * nothing persists across them.
 */
class PayeeCategoryCache {
  private readonly cache = new Map<string, Promise<UnifiedResponse>>();

  private hits = 0;

  private misses = 0;

  /**
   * Returns the cached response for `key` (plus whether this call is the one that
   * produced it, for logging/metrics — checking that separately would race once
   * concurrent calls are possible), calling `factory` to produce (and cache) one on a
   * miss. `key` may be undefined/empty when the caller has nothing stable to key on —
   * that's always a fresh call, and the result is never cached, since caching under a
   * made-up or shared "no key" bucket would incorrectly merge unrelated transactions.
   */
  public async getOrCreate(
    key: string | undefined | null,
    factory: () => Promise<UnifiedResponse>,
  ): Promise<{ response: UnifiedResponse; fromCache: boolean }> {
    if (!key) {
      return { response: await factory(), fromCache: false };
    }

    const existing = this.cache.get(key);
    if (existing) {
      this.hits += 1;
      return { response: await existing, fromCache: true };
    }

    this.misses += 1;
    const pending = factory().catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, pending);
    return { response: await pending, fromCache: false };
  }

  public logSummary(): void {
    const total = this.hits + this.misses;
    if (total === 0) {
      return;
    }
    console.log(
      `Payee category cache: ${this.hits}/${total} transactions reused a cached `
      + `categorization (${this.cache.size} unique keys seen)`,
    );
  }
}

export default PayeeCategoryCache;
