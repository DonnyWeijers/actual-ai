import { TransactionEntity } from '@actual-app/core/src/types/models';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import { UnifiedResponse } from '../src/types';
import mapWithConcurrency from '../src/utils/concurrency';

function transaction(id: string): TransactionEntity {
  return {
    id, account: 'acc-1', amount: -100, date: '2026-01-01',
  };
}

function newCategoryResponse(name: string, groupName: string): UnifiedResponse {
  return {
    type: 'new',
    newCategory: { name, groupName, groupIsNew: false },
  };
}

describe('NewCategoryStrategy concurrency', () => {
  test('concurrent calls for the same suggested category do not lose any transaction', async () => {
    const strategy = new NewCategoryStrategy();
    const suggestedCategories = new Map<string, {
      name: string;
      groupName: string;
      groupIsNew: boolean;
      groupId?: string;
      transactions: TransactionEntity[];
    }>();
    const response = newCategoryResponse('Pet Supplies', 'Pets');
    const transactionIds = Array.from({ length: 50 }, (_, i) => `tx-${i}`);

    // Run genuinely concurrently (limit > 1) so any interleaving bug would show up.
    await mapWithConcurrency(transactionIds, 8, async (id) => {
      await strategy.process(transaction(id), response, new Map(), suggestedCategories);
    });

    expect(suggestedCategories.size).toBe(1);
    const entry = suggestedCategories.get('Pets:Pet Supplies');
    expect(entry?.transactions).toHaveLength(50);
    expect(new Set(entry?.transactions.map((t) => t.id)).size).toBe(50);
  });

  test('concurrent calls for different suggested categories each keep their own transactions', async () => {
    const strategy = new NewCategoryStrategy();
    const suggestedCategories = new Map<string, {
      name: string;
      groupName: string;
      groupIsNew: boolean;
      groupId?: string;
      transactions: TransactionEntity[];
    }>();
    const categoryNames = ['Pets', 'Sports', 'Coffee', 'Travel'];

    await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      8,
      async (i) => {
        const groupName = categoryNames[i % categoryNames.length];
        await strategy.process(
          transaction(`tx-${i}`),
          newCategoryResponse(`${groupName} Category`, groupName),
          new Map(),
          suggestedCategories,
        );
      },
    );

    expect(suggestedCategories.size).toBe(categoryNames.length);
    const totalTransactions = Array.from(suggestedCategories.values())
      .reduce((sum, entry) => sum + entry.transactions.length, 0);
    expect(totalTransactions).toBe(40);
  });
});
