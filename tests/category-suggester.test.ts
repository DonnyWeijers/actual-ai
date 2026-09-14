import { TransactionEntity } from '@actual-app/core/src/types/models';
import CategorySuggester from '../src/transaction/category-suggester';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import SimilarityCalculator from '../src/similarity-calculator';
import TagService from '../src/transaction/tag-service';
import InMemoryActualApiService from './test-doubles/in-memory-actual-api-service';

function transaction(id: string): TransactionEntity {
  return {
    id,
    account: 'acc-1',
    amount: -1000,
    date: '2026-01-01',
    notes: 'Some payee',
  };
}

function suggestions(entries: { name: string; groupName: string; transactionIds: string[] }[]) {
  return new Map(entries.map((entry, index) => [
    `key-${index}`,
    {
      name: entry.name,
      groupName: entry.groupName,
      groupIsNew: false,
      transactions: entry.transactionIds.map(transaction),
    },
  ]));
}

describe('CategorySuggester', () => {
  let actualApiService: InMemoryActualApiService;
  let categorySuggester: CategorySuggester;

  beforeEach(() => {
    actualApiService = new InMemoryActualApiService();
    actualApiService.setTransactions([transaction('t1'), transaction('t2')]);
    categorySuggester = new CategorySuggester(
      actualApiService,
      new CategorySuggestionOptimizer(new SimilarityCalculator()),
      new TagService('#actual-ai-miss', '#actual-ai'),
    );
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reuses an existing category instead of creating a duplicate', async () => {
    const groups = [{
      id: 'g1',
      name: 'Bills',
      categories: [{
        id: 'c1', name: 'Utilities', group_id: 'g1', is_income: false,
      }],
    }];
    actualApiService.setCategoryGroups(groups);
    const createCategory = jest.spyOn(actualApiService, 'createCategory');

    await categorySuggester.suggest(
      suggestions([{ name: 'utilities', groupName: 'Bills', transactionIds: ['t1'] }]),
      [transaction('t1')],
      groups,
    );

    expect(createCategory).not.toHaveBeenCalled();
    const [updated] = await actualApiService.getTransactions();
    expect(updated.category).toBe('c1');
  });

  test('creates a category only once when two suggestions resolve to the same one', async () => {
    const groups = [{ id: 'g1', name: 'Bills', categories: [] }];
    actualApiService.setCategoryGroups(groups);
    const createCategory = jest.spyOn(actualApiService, 'createCategory');

    await categorySuggester.suggest(
      suggestions([
        { name: 'Utilities', groupName: 'Bills', transactionIds: ['t1'] },
        { name: 'utilities', groupName: 'Bills', transactionIds: ['t2'] },
      ]),
      [transaction('t1'), transaction('t2')],
      groups,
    );

    expect(createCategory).toHaveBeenCalledTimes(1);
    const updated = await actualApiService.getTransactions();
    expect(updated[0].category).toBeDefined();
    expect(updated[1].category).toBe(updated[0].category);
  });

  test('falls back to the existing category when creation reports a duplicate', async () => {
    const groups = [{ id: 'g1', name: 'Bills', categories: [] }];
    actualApiService.setCategoryGroups(groups);
    // Hidden categories are absent from the group listing but still collide on create.
    actualApiService.setCategories([{
      id: 'hidden-1', name: 'Utilities', group_id: 'g1', is_income: false,
    }]);
    jest.spyOn(actualApiService, 'createCategory').mockRejectedValue(
      new Error("Category 'Utilities' already exists in group 'g1'"),
    );

    await categorySuggester.suggest(
      suggestions([{ name: 'Utilities', groupName: 'Bills', transactionIds: ['t1'] }]),
      [transaction('t1')],
      groups,
    );

    const [updated] = await actualApiService.getTransactions();
    expect(updated.category).toBe('hidden-1');
  });

  test('refetches categories at most once per suggest() call, even with multiple hidden-category collisions', async () => {
    const groups = [{ id: 'g1', name: 'Bills', categories: [] }];
    actualApiService.setCategoryGroups(groups);
    actualApiService.setCategories([
      {
        id: 'hidden-1', name: 'Utilities', group_id: 'g1', is_income: false,
      },
      {
        id: 'hidden-2', name: 'Rent', group_id: 'g1', is_income: false,
      },
    ]);
    jest.spyOn(actualApiService, 'createCategory').mockRejectedValue(
      new Error('already exists'),
    );
    const getCategories = jest.spyOn(actualApiService, 'getCategories');

    await categorySuggester.suggest(
      suggestions([
        { name: 'Utilities', groupName: 'Bills', transactionIds: ['t1'] },
        { name: 'Rent', groupName: 'Bills', transactionIds: ['t2'] },
      ]),
      [transaction('t1'), transaction('t2')],
      groups,
    );

    expect(getCategories).toHaveBeenCalledTimes(1);
    const [t1, t2] = await actualApiService.getTransactions();
    expect(t1.category).toBe('hidden-1');
    expect(t2.category).toBe('hidden-2');
  });

  test('a second, separate suggest() call refetches categories again — the memo does not leak across runs', async () => {
    const groups = [{ id: 'g1', name: 'Bills', categories: [] }];
    actualApiService.setCategoryGroups(groups);
    actualApiService.setCategories([
      {
        id: 'hidden-1', name: 'Utilities', group_id: 'g1', is_income: false,
      },
    ]);
    jest.spyOn(actualApiService, 'createCategory').mockRejectedValue(
      new Error('already exists'),
    );
    const getCategories = jest.spyOn(actualApiService, 'getCategories');

    await categorySuggester.suggest(
      suggestions([{ name: 'Utilities', groupName: 'Bills', transactionIds: ['t1'] }]),
      [transaction('t1')],
      groups,
    );
    await categorySuggester.suggest(
      suggestions([{ name: 'Utilities', groupName: 'Bills', transactionIds: ['t2'] }]),
      [transaction('t2')],
      groups,
    );

    expect(getCategories).toHaveBeenCalledTimes(2);
  });

  test('creates many categories with bounded, not unbounded, concurrency', async () => {
    const groups = [{ id: 'g1', name: 'Bills', categories: [] }];
    actualApiService.setCategoryGroups(groups);
    let active = 0;
    let peak = 0;
    jest.spyOn(actualApiService, 'createCategory').mockImplementation(async (name) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      active -= 1;
      return `cat-${name}`;
    });

    // Genuinely distinct names — near-identical ones (e.g. "Category 0".."Category
    // 19") would get merged by the similarity optimizer before creation, leaving
    // nothing to run concurrently and defeating the point of this test.
    const distinctNames = [
      'Groceries', 'Coffee Shops', 'Electronics', 'Travel', 'Pet Supplies', 'Insurance',
      'Gym Membership', 'Streaming Services', 'Car Maintenance', 'Home Improvement',
      'Medical Expenses', 'Baby Supplies', 'Gardening', 'Photography Gear', 'Gaming',
      'Beauty Products', 'Office Supplies', 'Parking Fees', 'Delivery Fees', 'Wine',
    ];
    const entries = distinctNames.map((name, i) => ({
      name, groupName: 'Bills', transactionIds: [`t${i}`],
    }));
    actualApiService.setTransactions(entries.map((e) => transaction(e.transactionIds[0])));

    const txs = entries.map((e) => transaction(e.transactionIds[0]));
    await categorySuggester.suggest(suggestions(entries), txs, groups);

    expect(peak).toBeGreaterThan(1); // actually ran concurrently, not sequentially
    expect(peak).toBeLessThanOrEqual(5); // but bounded, not unbounded (R8)
  });

  test('updates many transactions for one category with bounded, not unbounded, concurrency', async () => {
    const groups = [{
      id: 'g1',
      name: 'Bills',
      categories: [{
        id: 'c1', name: 'Utilities', group_id: 'g1', is_income: false,
      }],
    }];
    actualApiService.setCategoryGroups(groups);
    const transactionIds = Array.from({ length: 20 }, (_, i) => `t${i}`);
    actualApiService.setTransactions(transactionIds.map(transaction));
    let active = 0;
    let peak = 0;
    jest.spyOn(actualApiService, 'updateTransactionNotesAndCategory').mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      active -= 1;
    });

    await categorySuggester.suggest(
      suggestions([{ name: 'Utilities', groupName: 'Bills', transactionIds }]),
      transactionIds.map(transaction),
      groups,
    );

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});
