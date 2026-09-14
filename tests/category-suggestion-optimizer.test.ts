import { TransactionEntity } from '@actual-app/core/src/types/models';
import SimilarityCalculator from '../src/similarity-calculator';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import GivenActualData from './test-doubles/given/given-actual-data';

describe('CategorySuggestionOptimizer', () => {
  let similarityCalculator: SimilarityCalculator;
  let optimizer: CategorySuggestionOptimizer;

  beforeEach(() => {
    similarityCalculator = new SimilarityCalculator();
    optimizer = new CategorySuggestionOptimizer(similarityCalculator);
  });

  describe('optimizeCategorySuggestions', () => {
    it('should not modify a map with a single category', () => {
      const transaction = GivenActualData.createTransaction('1', -1000, 'Test Transaction');
      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();

      suggestedCategories.set('Group:Category', {
        name: 'Category',
        groupName: 'Group',
        groupIsNew: true,
        transactions: [transaction],
      });

      const result = optimizer.optimizeCategorySuggestions(suggestedCategories);

      expect(result.size).toBe(1);
      expect(result.get('Group:Category')).toEqual({
        name: 'Category',
        groupName: 'Group',
        groupIsNew: true,
        transactions: [transaction],
      });
    });

    it('should merge similar categories across different groups', () => {
      const transaction1 = GivenActualData.createTransaction('1', -1000, 'Transaction 1');
      const transaction2 = GivenActualData.createTransaction('2', -2000, 'Transaction 2');

      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();

      suggestedCategories.set('Group1:Amazon', {
        name: 'Amazon',
        groupName: 'Group1',
        groupIsNew: true,
        transactions: [transaction1],
      });

      suggestedCategories.set('Group2:amazon.com', {
        name: 'amazon.com',
        groupName: 'Group2',
        groupIsNew: false,
        transactions: [transaction2],
      });

      // No mock: "Amazon"/"amazon.com" genuinely scores above the merge threshold
      // (pinned at 0.818 in similarity-calculator.test.ts) via the real calculator —
      // the optimizer no longer calls calculateNameSimilarity internally (it uses
      // represent()/calculateSimilarity() to precompute once per candidate), so a
      // mock on that method wouldn't intercept anything real here.
      const result = optimizer.optimizeCategorySuggestions(suggestedCategories);

      // Should merge into one category
      expect(result.size).toBe(1);

      // The group with more categories wins (in this case, both have 1, so first group wins)
      const mergedKey = Array.from(result.keys())[0];
      const merged = result.get(mergedKey);

      expect(merged).toBeDefined();
      expect(merged?.groupIsNew).toBe(true); // true wins over false
      expect(merged?.transactions.length).toBe(2); // Transactions merged
    });

    it('should not merge categories with low similarity', () => {
      const transaction1 = GivenActualData.createTransaction('1', -1000, 'Transaction 1');
      const transaction2 = GivenActualData.createTransaction('2', -2000, 'Transaction 2');

      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();

      suggestedCategories.set('Group1:Groceries', {
        name: 'Groceries',
        groupName: 'Group1',
        groupIsNew: true,
        transactions: [transaction1],
      });

      suggestedCategories.set('Group2:Entertainment', {
        name: 'Entertainment',
        groupName: 'Group2',
        groupIsNew: false,
        transactions: [transaction2],
      });

      // No mock: "Groceries"/"Entertainment" share no stems, so the real calculator
      // (via isDefinitelyDissimilar's provably-safe skip) scores them 0 regardless.
      const result = optimizer.optimizeCategorySuggestions(suggestedCategories);

      // Should not merge
      expect(result.size).toBe(2);
      expect(result.has('Group1:Groceries')).toBe(true);
      expect(result.has('Group2:Entertainment')).toBe(true);
    });

    it('should use the most frequent group name when merging', () => {
      const transaction1 = GivenActualData.createTransaction('1', -1000, 'Transaction 1');
      const transaction2 = GivenActualData.createTransaction('2', -2000, 'Transaction 2');
      const transaction3 = GivenActualData.createTransaction('3', -3000, 'Transaction 3');

      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();

      suggestedCategories.set('GroupA:Coffee', {
        name: 'Coffee',
        groupName: 'GroupA',
        groupIsNew: false,
        transactions: [transaction1],
      });

      suggestedCategories.set('GroupB:Coffee Shop', {
        name: 'Coffee Shop',
        groupName: 'GroupB',
        groupIsNew: false,
        transactions: [transaction2],
      });

      suggestedCategories.set('GroupB:Coffee Place', {
        name: 'Coffee Place',
        groupName: 'GroupB',
        groupIsNew: true,
        transactions: [transaction3],
      });

      // No mock: "Coffee"/"Coffee Shop"/"Coffee Place" genuinely score above threshold
      // via the real calculator (shared "coffee" stem).
      const result = optimizer.optimizeCategorySuggestions(suggestedCategories);

      // Should merge into one category
      expect(result.size).toBe(1);

      const mergedKey = Array.from(result.keys())[0];
      const merged = result.get(mergedKey);

      // GroupB should win as the most frequent
      expect(merged?.groupName).toBe('GroupB');
      expect(merged?.groupIsNew).toBe(true); // true wins over false
      expect(merged?.transactions.length).toBe(3); // All transactions merged
    });
  });

  test('should properly optimize category suggestions', () => {
    // Arrange
    const transaction: TransactionEntity = {
      id: 'txn1',
      date: '2023-01-01',
      account: 'account1',
      amount: -50,
      payee: 'payee1',
      imported_payee: 'Medical Visit',
      category: undefined,
      notes: '',
      cleared: true,
      reconciled: false,
      transfer_id: undefined,
      tombstone: false,
      schedule: undefined,
      sort_order: 0,
      starting_balance_flag: false,
      is_child: false,
      is_parent: false,
      parent_id: undefined,
      error: undefined,
    };

    const suggestedCategories = new Map<string, {
      name: string;
      groupName: string;
      groupIsNew: boolean;
      groupId?: string;
      transactions: TransactionEntity[];
    }>();

    suggestedCategories.set('Health & Medical:Medical Expenses', {
      name: 'Medical Expenses',
      groupName: 'Health & Medical',
      groupIsNew: true, // Expect groupId to be undefined after optimization for new groups
      transactions: [transaction],
    });

    // Act
    const optimizedCategories = optimizer.optimizeCategorySuggestions(
      suggestedCategories,
    );

    // Assert
    expect(optimizedCategories.size).toBe(1);
    const optimizedSuggestion = optimizedCategories.get('Health & Medical:Medical Expenses');
    expect(optimizedSuggestion).toBeDefined();
    expect(optimizedSuggestion?.name).toBe('Medical Expenses');
    expect(optimizedSuggestion?.groupName).toBe('Health & Medical');
    expect(optimizedSuggestion?.groupIsNew).toBe(true);
    // The optimizer should not assign a groupId for new groups.
    // The TransactionService is responsible for creating the group and getting the ID.
    expect(optimizedSuggestion?.groupId).toBeUndefined();
  });

  describe('determinism (2.4)', () => {
    function buildSuggestions(order: string[]): Map<string, {
      name: string;
      groupName: string;
      groupIsNew: boolean;
      groupId?: string;
      transactions: TransactionEntity[];
    }> {
      const byName: Record<string, { name: string; groupName: string }> = {
        Sport: { name: 'Sport', groupName: 'Fitness' },
        Sports: { name: 'Sports', groupName: 'Fitness' },
        Sporting: { name: 'Sporting', groupName: 'Fitness' },
        Groceries: { name: 'Groceries', groupName: 'Food' },
        Electronics: { name: 'Electronics', groupName: 'Shopping' },
      };
      const map = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();
      order.forEach((name, i) => {
        const def = byName[name];
        map.set(`${def.groupName}:${def.name}`, {
          ...def,
          groupIsNew: false,
          transactions: [GivenActualData.createTransaction(`tx-${name}`, -100 * (i + 1), name)],
        });
      });
      return map;
    }

    it('produces the same clustering regardless of input order', () => {
      const forward = optimizer.optimizeCategorySuggestions(
        buildSuggestions(['Sport', 'Sports', 'Sporting', 'Groceries', 'Electronics']),
      );
      const shuffled = new CategorySuggestionOptimizer(new SimilarityCalculator())
        .optimizeCategorySuggestions(
          buildSuggestions(['Electronics', 'Sporting', 'Groceries', 'Sport', 'Sports']),
        );

      const summarize = (result: typeof forward) => Array.from(result.values())
        .map((v) => ({
          groupName: v.groupName,
          transactionIds: v.transactions.map((t) => t.id).sort(),
        }))
        .sort((a, b) => a.transactionIds[0].localeCompare(b.transactionIds[0]));

      expect(summarize(shuffled)).toEqual(summarize(forward));
      // Sanity: it actually merged (1 cluster for the 3 sport-ish names, not 3).
      expect(forward.size).toBe(3);
    });
  });

  describe('transaction → final category mapping survives merging (2.5)', () => {
    it('every transaction from every merged name ends up on the single resulting entry', () => {
      const txSport = GivenActualData.createTransaction('tx1', -100, 'Sport');
      const txSports = GivenActualData.createTransaction('tx2', -200, 'Sports');
      const txSporting = GivenActualData.createTransaction('tx3', -300, 'Sporting');

      const suggestedCategories = new Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>();
      suggestedCategories.set('Fitness:Sport', {
        name: 'Sport', groupName: 'Fitness', groupIsNew: false, transactions: [txSport],
      });
      suggestedCategories.set('Fitness:Sports', {
        name: 'Sports', groupName: 'Fitness', groupIsNew: false, transactions: [txSports],
      });
      suggestedCategories.set('Fitness:Sporting', {
        name: 'Sporting', groupName: 'Fitness', groupIsNew: false, transactions: [txSporting],
      });

      const result = optimizer.optimizeCategorySuggestions(suggestedCategories);

      expect(result.size).toBe(1);
      const [merged] = result.values();
      const ids = merged.transactions.map((t) => t.id).sort();
      expect(ids).toEqual(['tx1', 'tx2', 'tx3']);
    });
  });
});
