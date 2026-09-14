import { TransactionEntity } from '@actual-app/core/src/types/models';
import type {
  APICategoryEntity, APICategoryGroupEntity, ProcessingStrategyI, UnifiedResponse,
} from '../../types';
import metrics from '../../utils/metrics';

class NewCategoryStrategy implements ProcessingStrategyI {
  public isSatisfiedBy(response: UnifiedResponse): boolean {
    if (response.newCategory === undefined) {
      return false;
    }
    return response.type === 'new';
  }

  public async process(
    transaction: TransactionEntity,
    response: UnifiedResponse,
    categoryById: Map<string, APICategoryEntity | APICategoryGroupEntity>,
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ) {
    if (response.newCategory === undefined) {
      throw new Error('No newCategory in response');
    }
    metrics.incr('category_suggestions_raw');
    // Case-normalized so "Coffee"/"coffee"/"COFFEE" collapse into one suggestion
    // instead of three (R6) — the stored name/groupName below keep whatever casing
    // the first occurrence used, so display is unaffected.
    const categoryKey = `${response.newCategory.groupName}:${response.newCategory.name}`.toLowerCase();

    // Safe to run concurrently (Phase 3, LLM_CONCURRENCY > 1) without a lock: this
    // get-then-set/push has no `await` anywhere in it, so JS never interleaves
    // another call between the read and the write — the only place execution could
    // hand off to another concurrent transaction is at an `await`, and there isn't
    // one here. See tests/new-category-strategy.test.ts for a concurrency regression
    // test pinning this.
    const existing = suggestedCategories.get(categoryKey);
    if (existing) {
      existing.transactions.push(transaction);
    } else {
      suggestedCategories.set(categoryKey, {
        ...response.newCategory,
        transactions: [transaction],
      });
    }
    return Promise.resolve();
  }
}

export default NewCategoryStrategy;
