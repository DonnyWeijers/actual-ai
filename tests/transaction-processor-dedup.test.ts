import { TransactionEntity } from '@actual-app/core/src/types/models';
import * as config from '../src/config';
import TransactionProcessor from '../src/transaction/transaction-processor';
import PayeeCategoryCache from '../src/transaction/payee-category-cache';
import TagService from '../src/transaction/tag-service';
import RuleMatchStrategy from '../src/transaction/processing-strategy/rule-match-strategy';
import ExistingCategoryStrategy from '../src/transaction/processing-strategy/existing-category-strategy';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import InMemoryActualApiService from './test-doubles/in-memory-actual-api-service';
import MockedPromptGenerator from './test-doubles/mocked-prompt-generator';
import { UnifiedResponse, LlmServiceI } from '../src/types';

// Required test: "Same classification inputs — one LLM call. Different context — not
// shared." Exercised through the real TransactionProcessor + PayeeCategoryCache +
// dedup-key wiring, not just the isolated units (see dedup-key.test.ts and
// payee-category-cache.test.ts for those).
describe('TransactionProcessor request deduplication (integration)', () => {
  const originalIsFeatureEnabled = config.isFeatureEnabled;
  let mockIsFeatureEnabled: jest.SpyInstance;
  let countingLlm: LlmServiceI & { callCount: number };
  let processor: TransactionProcessor;
  let api: InMemoryActualApiService;
  let registeredTransactions: TransactionEntity[];

  function makeTransaction(id: string, importedPayee: string, payee?: string): TransactionEntity {
    return {
      id, account: 'acct-1', amount: -100, date: '2026-09-01', imported_payee: importedPayee, payee,
    };
  }

  beforeEach(() => {
    mockIsFeatureEnabled = jest.spyOn(config, 'isFeatureEnabled');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    api = new InMemoryActualApiService();
    registeredTransactions = [];
    api.setCategoryGroups([{
      id: 'grp-1', name: 'Food', categories: [{ id: 'cat-1', name: 'Groceries', group_id: 'grp-1' }],
    }]);
    api.setCategories([{ id: 'cat-1', name: 'Groceries', group_id: 'grp-1' }]);

    let calls = 0;
    countingLlm = {
      callCount: 0,
      ask(): Promise<UnifiedResponse> {
        calls += 1;
        countingLlm.callCount = calls;
        return Promise.resolve({ type: 'existing', categoryId: 'cat-1' });
      },
    };

    const tagService = new TagService('#actual-ai-miss', '#actual-ai');
    const cache = new PayeeCategoryCache();
    processor = new TransactionProcessor(
      api,
      countingLlm,
      new MockedPromptGenerator(),
      tagService,
      [
        new RuleMatchStrategy(api, tagService),
        new ExistingCategoryStrategy(api, tagService),
        new NewCategoryStrategy(),
      ],
      cache,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function process(transaction: TransactionEntity): Promise<void> {
    registeredTransactions.push(transaction);
    api.setTransactions(registeredTransactions);
    const promptContext = processor.createPromptContext([], [], []);
    await processor.process(transaction, promptContext, new Map(), new Map());
  }

  test('resolved payee: repeat payee id shares one LLM call regardless of the flag', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => (f === 'dedupeUnresolvedPayees' ? false : originalIsFeatureEnabled(f)));

    await process(makeTransaction('tx-1', 'ALBERT HEIJN 1234', 'payee-ah'));
    await process(makeTransaction('tx-2', 'ALBERT HEIJN 9981', 'payee-ah'));

    expect(countingLlm.callCount).toBe(1);
  });

  test('unresolved payee, flag OFF (default): same merchant text still calls the LLM twice — backward compatible', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => (f === 'dedupeUnresolvedPayees' ? false : originalIsFeatureEnabled(f)));

    await process(makeTransaction('tx-1', 'ALBERT HEIJN 1234'));
    await process(makeTransaction('tx-2', 'ALBERT HEIJN 9981'));

    expect(countingLlm.callCount).toBe(2);
  });

  test('unresolved payee, flag ON: same merchant text (different reference noise) shares one LLM call', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => (f === 'dedupeUnresolvedPayees' ? true : originalIsFeatureEnabled(f)));

    await process(makeTransaction('tx-1', 'ALBERT HEIJN 1234'));
    await process(makeTransaction('tx-2', 'ALBERT HEIJN 9981'));

    expect(countingLlm.callCount).toBe(1);
  });

  test('unresolved payee, flag ON: genuinely different merchants are not shared', async () => {
    mockIsFeatureEnabled.mockImplementation((f: string) => (f === 'dedupeUnresolvedPayees' ? true : originalIsFeatureEnabled(f)));

    await process(makeTransaction('tx-1', 'ALBERT HEIJN 1234'));
    await process(makeTransaction('tx-2', 'COOLBLUE ROTTERDAM'));

    expect(countingLlm.callCount).toBe(2);
  });
});
