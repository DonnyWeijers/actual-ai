import { UnifiedResponse } from '../types';

/**
 * Caches the LLM's categorization response per payee for the lifetime of a single
 * classification run. Actual already deduplicates bank transactions into a stable
 * payee record, so any transaction sharing that payee id has, in practice, already
 * been judged by the model once — asking again just repeats the same full prompt
 * (categories + rules) for the same answer. Scoped to one run only: categories and
 * rules can change between scheduled runs, so nothing persists across them.
 */
class PayeeCategoryCache {
  private readonly cache = new Map<string, UnifiedResponse>();

  private hits = 0;

  private misses = 0;

  public get(payeeId: string | undefined | null): UnifiedResponse | undefined {
    if (!payeeId) {
      return undefined;
    }
    const cached = this.cache.get(payeeId);
    if (cached) {
      this.hits += 1;
    } else {
      this.misses += 1;
    }
    return cached;
  }

  public set(payeeId: string | undefined | null, response: UnifiedResponse): void {
    if (!payeeId) {
      return;
    }
    this.cache.set(payeeId, response);
  }

  public logSummary(): void {
    const total = this.hits + this.misses;
    if (total === 0) {
      return;
    }
    console.log(
      `Payee category cache: ${this.hits}/${total} transactions reused a cached `
      + `categorization (${this.cache.size} unique payees seen)`,
    );
  }
}

export default PayeeCategoryCache;
