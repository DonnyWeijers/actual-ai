import { TransactionEntity } from '@actual-app/core/src/types/models';
import BatchTransactionProcessor from '../src/transaction/batch-transaction-processor';
import TransactionProcessor from '../src/transaction/transaction-processor';
import PayeeCategoryCache from '../src/transaction/payee-category-cache';

function transaction(id: string): TransactionEntity {
  return {
    id, account: 'acc-1', amount: -100, date: '2026-01-01', imported_payee: `Merchant ${id}`,
  };
}

describe('BatchTransactionProcessor concurrency', () => {
  let processor: jest.Mocked<Pick<TransactionProcessor, 'process' | 'createPromptContext'>>;
  let cache: PayeeCategoryCache;
  let processOrder: string[];
  let activeCount: number;
  let peakActive: number;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    processOrder = [];
    activeCount = 0;
    peakActive = 0;

    processor = {
      createPromptContext: jest.fn().mockReturnValue({
        template: () => '', groupsWithCategories: [], rulesDescription: [], payeeNameById: new Map(), hasWebSearchTool: false,
      }),
      process: jest.fn().mockImplementation(async (tx: TransactionEntity) => {
        activeCount += 1;
        peakActive = Math.max(peakActive, activeCount);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        processOrder.push(tx.id);
        activeCount -= 1;
      }),
    };
    cache = new PayeeCategoryCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('concurrency=1 (default) processes strictly sequentially with the fixed inter-batch pause', async () => {
    const batchProcessor = new BatchTransactionProcessor(
      processor as unknown as TransactionProcessor,
      2, // batchSize
      cache,
      1,
    );
    const transactions = ['a', 'b', 'c', 'd', 'e'].map(transaction);

    const start = Date.now();
    await batchProcessor.process(transactions, [], [], [], [], new Map());
    const elapsed = Date.now() - start;

    expect(processOrder).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peakActive).toBe(1);
    // 5 items / batchSize 2 = 3 batches -> 2 inter-batch pauses of 2000ms each.
    expect(elapsed).toBeGreaterThanOrEqual(4000);
  }, 10000);

  test('concurrency > 1 processes with bounded parallelism and no fixed pause', async () => {
    const batchProcessor = new BatchTransactionProcessor(
      processor as unknown as TransactionProcessor,
      2,
      cache,
      3,
    );
    const transactions = ['a', 'b', 'c', 'd', 'e', 'f'].map(transaction);

    const start = Date.now();
    await batchProcessor.process(transactions, [], [], [], [], new Map());
    const elapsed = Date.now() - start;

    expect(processOrder).toHaveLength(6);
    expect(new Set(processOrder).size).toBe(6);
    expect(peakActive).toBe(3);
    // No 2000ms pauses: 6 items at concurrency 3, ~5ms each, two rounds -> comfortably under 1s.
    expect(elapsed).toBeLessThan(1000);
  });

  test('concurrency > 1: an error from one transaction does not stop the others from being processed', async () => {
    processor.process.mockImplementation((tx: unknown) => {
      const { id } = (tx as TransactionEntity);
      if (id === 'bad') {
        return Promise.reject(new Error('boom'));
      }
      processOrder.push(id);
      return Promise.resolve();
    });
    const batchProcessor = new BatchTransactionProcessor(
      processor as unknown as TransactionProcessor,
      2,
      cache,
      3,
    );
    const transactions = ['a', 'bad', 'c'].map(transaction);

    await batchProcessor.process(transactions, [], [], [], [], new Map());

    expect(processOrder.sort()).toEqual(['a', 'c']);
  });
});
