/* eslint-disable no-console */
/**
 * Phase 0 benchmark harness (see PERFORMANCE.md). Drives the REAL
 * TransactionService.processTransactions() — same wiring as src/container.ts —
 * against a fake ActualApiServiceI (InMemoryActualApiService, already used by the
 * existing test suite) and a fake LlmServiceI that simulates network latency but is
 * otherwise inert. Everything except the LLM network call and the Actual Budget HTTP
 * calls is the real production code path: real PromptGenerator, real
 * PayeeCategoryCache, real CategorySuggester, real CategorySuggestionOptimizer, real
 * SimilarityCalculator.
 *
 * This measures real call counts and real algorithmic overhead (prompt building,
 * array scans, the fixed inter-batch sleep). Wall-clock numbers below the fake LLM's
 * configured latency floor are real too, just bounded by a synthetic per-call cost —
 * that's stated wherever a number is reported. Nothing here is invented: every number
 * printed comes from src/utils/metrics.ts counters populated by the real code path,
 * or from Date.now() around the real call.
 *
 * Not part of the Docker build (see tsconfig.json "exclude"). Run with:
 *   npm run bench
 */

import {
  APIAccountEntity, APICategoryEntity, APICategoryGroupEntity, APIPayeeEntity,
} from '@actual-app/core/src/server/api-models';
import { RuleEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import { LlmServiceI, UnifiedResponse } from '../src/types';
import metrics from '../src/utils/metrics';
import TagService from '../src/transaction/tag-service';
import RuleMatchStrategy from '../src/transaction/processing-strategy/rule-match-strategy';
import ExistingCategoryStrategy from '../src/transaction/processing-strategy/existing-category-strategy';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import CategorySuggester from '../src/transaction/category-suggester';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import SimilarityCalculator from '../src/similarity-calculator';
import PayeeCategoryCache from '../src/transaction/payee-category-cache';
import TransactionProcessor from '../src/transaction/transaction-processor';
import BatchTransactionProcessor from '../src/transaction/batch-transaction-processor';
import TransactionFilterer from '../src/transaction/transaction-filterer';
import TransactionService from '../src/transaction-service';
import PromptGenerator from '../src/prompt-generator';
import { promptTemplate } from '../src/config';
import InMemoryActualApiService from '../tests/test-doubles/in-memory-actual-api-service';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so every run of a given dataset is identical —
// a benchmark that produces different numbers each run is useless for comparing
// phases against each other.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Zipf-ish weight: merchant i (0-indexed, most frequent first) gets weight 1/(i+1).
function zipfWeights(count: number): number[] {
  const weights = Array.from({ length: count }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((s, w) => s + w, 0);
  return weights.map((w) => w / total);
}

function pickWeighted(rng: () => number, weights: number[]): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    acc += weights[i];
    if (r <= acc) return i;
  }
  return weights.length - 1;
}

const EXISTING_CATEGORY_NAMES = [
  'Groceries', 'Dining Out', 'Coffee Shops', 'Transportation', 'Entertainment',
  'Utilities', 'Rent', 'Insurance', 'Subscriptions', 'Shopping', 'Travel',
  'Healthcare', 'Fitness', 'Electronics', 'Gifts', 'Pets', 'Home', 'Education',
  'Personal Care', 'Fees', 'Salary', 'Investments', 'Savings', 'Taxes',
  'Charity', 'Childcare', 'Phone', 'Internet', 'Clothing', 'Furniture',
  'Books', 'Hobbies', 'Parking', 'Tolls', 'Alcohol', 'Tobacco', 'Vitamins',
  'Software', 'Hardware', 'Miscellaneous',
];
const GROUP_NAMES = ['Food', 'Bills', 'Lifestyle', 'Transport', 'Income', 'Savings', 'Home', 'Other'];

// A small pool of "new category" concepts a fake LLM might suggest, each with
// intentional near-duplicate variants (case, plural) — the same trap real LLMs fall
// into (R5/R6/R7 in PERFORMANCE.md) — so the optimizer has real merging to do.
const NEW_CATEGORY_CONCEPTS = [
  ['Sports', 'Sport', 'sports'], ['Coffee', 'coffee', 'COFFEE'], ['Pet Supplies', 'Pets Supplies'],
  ['Streaming Services', 'Streaming Service', 'streaming services'], ['Car Maintenance', 'Car Maintenance '],
  ['Gym Membership', 'Gym Memberships'], ['Online Shopping', 'online shopping'],
  ['Public Transit', 'Public Transport'], ['Home Improvement', 'Home Improvements'],
  ['Medical', 'Medical Expenses'], ['Baby Supplies', 'Baby Supplies '], ['Wine', 'wine'],
  ['Gardening', 'Garden'], ['Photography', 'Photography Gear'], ['Music', 'Music Subscriptions'],
  ['Gaming', 'Video Games'], ['Beauty', 'Beauty Products'], ['Office Supplies', 'office supplies'],
  ['Parking Fees', 'Parking'], ['Delivery Fees', 'Delivery'],
];

function buildSeedData(existingCategoryCount: number, ruleCount: number) {
  const categoryGroups: APICategoryGroupEntity[] = GROUP_NAMES.map((name, gi) => ({
    id: `group-${gi}`,
    name,
    is_income: name === 'Income',
    categories: [],
  }));
  const categories: APICategoryEntity[] = [];
  for (let i = 0; i < existingCategoryCount; i += 1) {
    const group = categoryGroups[i % categoryGroups.length];
    const category: APICategoryEntity = {
      id: `cat-${i}`,
      name: EXISTING_CATEGORY_NAMES[i % EXISTING_CATEGORY_NAMES.length],
      group_id: group.id,
    };
    categories.push(category);
    group.categories = [...(group.categories ?? []), category];
  }

  const rules: RuleEntity[] = Array.from({ length: ruleCount }, (_, i) => ({
    id: `rule-${i}`,
    stage: null,
    conditionsOp: 'and',
    conditions: [{
      field: 'payee', op: 'contains', value: `Merchant${i}`, type: 'string',
    }],
    actions: [{
      field: 'category', op: 'set', value: categories[i % categories.length].id,
    }],
  }));

  return { categoryGroups, categories, rules };
}

interface Dataset {
  name: string;
  transactions: TransactionEntity[];
  payees: APIPayeeEntity[];
  accounts: APIAccountEntity[];
  categoryGroups: APICategoryGroupEntity[];
  categories: APICategoryEntity[];
  rules: RuleEntity[];
  /** merchant (payee id) -> scripted LLM response, so the fake LLM is deterministic
   * and a repeat payee always gets the same answer (realistic — this is also exactly
   * what makes payee-level caching valid). */
  scriptedResponses: Map<string, UnifiedResponse>;
}

function buildDataset(
  name: string,
  transactionCount: number,
  merchantCount: number,
  targetUniqueSuggestions: number,
  seed: number,
): Dataset {
  const rng = makeRng(seed);
  const { categoryGroups, categories, rules } = buildSeedData(40, 20);

  const payees: APIPayeeEntity[] = Array.from({ length: merchantCount }, (_, i) => ({
    id: `payee-${i}`,
    name: `Merchant${i}`,
  }));
  const account: APIAccountEntity = { id: 'acct-1', name: 'Checking' };

  // Response script per merchant: ~50% existing, ~15% rule, ~35% new (with the new
  // suggestions drawn from a pool sized to land near targetUniqueSuggestions after
  // clustering, deliberately including near-duplicate variants beforehand).
  const scriptedResponses = new Map<string, UnifiedResponse>();
  const conceptsNeeded = Math.max(1, Math.round(targetUniqueSuggestions));
  const concepts = Array.from(
    { length: conceptsNeeded },
    (_, i) => NEW_CATEGORY_CONCEPTS[i % NEW_CATEGORY_CONCEPTS.length],
  );

  payees.forEach((payee, i) => {
    const bucket = rng();
    if (bucket < 0.5) {
      const category = categories[i % categories.length];
      scriptedResponses.set(payee.id, { type: 'existing', categoryId: category.id });
    } else if (bucket < 0.65 && rules.length > 0) {
      const rule = rules[i % rules.length];
      const action = rule.actions.find((a) => 'field' in a && a.field === 'category');
      const categoryId = action && 'value' in action ? (action.value as string) : undefined;
      scriptedResponses.set(payee.id, { type: 'rule', ruleName: `rule-${i}`, categoryId });
    } else {
      const conceptVariants = concepts[i % concepts.length];
      const variant = conceptVariants[Math.floor(rng() * conceptVariants.length)];
      scriptedResponses.set(payee.id, {
        type: 'new',
        newCategory: {
          name: variant,
          groupName: GROUP_NAMES[i % GROUP_NAMES.length],
          groupIsNew: rng() < 0.1,
        },
      });
    }
  });

  const weights = zipfWeights(merchantCount);
  const transactions: TransactionEntity[] = Array.from({ length: transactionCount }, (_, i) => {
    const merchantIndex = pickWeighted(rng, weights);
    const payee = payees[merchantIndex];
    return {
      id: `tx-${i}`,
      account: account.id,
      amount: -Math.round(rng() * 10000),
      payee: payee.id,
      imported_payee: `${payee.name} REF${Math.floor(rng() * 999999)} ${Math.floor(rng() * 28) + 1}/09`,
      date: '2026-09-01',
      notes: '',
    };
  });

  return {
    name, transactions, payees, accounts: [account], categoryGroups, categories, rules, scriptedResponses,
  };
}

/**
 * Simulates network latency without a real network call. Mirrors the counters the
 * real LlmService.ask() records (see src/llm-service.ts) so metrics stay consistent
 * regardless of which LlmServiceI implementation the pipeline is wired to — the thing
 * under test here is everything ABOVE this boundary (caching, prompt building,
 * category planning), not the LLM call itself.
 */
class FakeLlmService implements LlmServiceI {
  public callCount = 0;

  constructor(
    private readonly scriptedResponses: Map<string, UnifiedResponse>,
    private readonly latencyMs: number,
    private readonly promptToPayeeId: (prompt: string) => string | undefined,
  ) {}

  async ask(prompt: string): Promise<UnifiedResponse> {
    this.callCount += 1;
    metrics.incr('llm_requests');
    metrics.incr('llm_prompt_chars_total', prompt.length);
    const start = Date.now();
    if (this.latencyMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, this.latencyMs); });
    }
    metrics.addMs('llm_request_ms_total', Date.now() - start);

    const payeeId = this.promptToPayeeId(prompt);
    const scripted = payeeId ? this.scriptedResponses.get(payeeId) : undefined;
    return scripted ?? { type: 'existing' };
  }
}

async function runDataset(dataset: Dataset, llmLatencyMs: number, concurrency: number): Promise<void> {
  metrics.reset();

  // Not dry run: this is a fully in-memory fake, so "writes" only mutate a local
  // array — no real Actual data is at risk, and running for real exercises (and
  // times) the full write path instead of short-circuiting it.
  const api = new InMemoryActualApiService(false);
  api.setCategoryGroups(dataset.categoryGroups);
  api.setCategories(dataset.categories);
  api.setPayees(dataset.payees);
  api.setAccounts(dataset.accounts);
  api.setTransactions(dataset.transactions);
  api.setRules(dataset.rules);

  // The fake LLM needs to know which payee a prompt was generated for. The real
  // prompt always contains the resolved payee name (see prompt.hbs "* Payee: ..."),
  // so recover it the same way a human reading the prompt would — this is scaffolding
  // for the fake, not a shortcut around the real PromptGenerator.
  const payeeNameToId = new Map(dataset.payees.map((p) => [p.name, p.id]));
  const promptToPayeeId = (prompt: string): string | undefined => {
    const match = /\* Payee: (.+)/.exec(prompt);
    const name = match?.[1]?.trim();
    return name ? payeeNameToId.get(name) : undefined;
  };

  const llm = new FakeLlmService(dataset.scriptedResponses, llmLatencyMs, promptToPayeeId);
  const promptGenerator = new PromptGenerator(promptTemplate);
  const tagService = new TagService('#actual-ai-miss', '#actual-ai');
  const ruleMatchStrategy = new RuleMatchStrategy(api, tagService);
  const existingCategoryStrategy = new ExistingCategoryStrategy(api, tagService);
  const newCategoryStrategy = new NewCategoryStrategy();
  const payeeCategoryCache = new PayeeCategoryCache();
  const transactionProcessor = new TransactionProcessor(
    api,
    llm,
    promptGenerator,
    tagService,
    [ruleMatchStrategy, existingCategoryStrategy, newCategoryStrategy],
    payeeCategoryCache,
  );
  const batchTransactionProcessor = new BatchTransactionProcessor(
    transactionProcessor,
    20,
    payeeCategoryCache,
    concurrency,
  );
  const transactionFilterer = new TransactionFilterer(tagService);
  const categorySuggester = new CategorySuggester(
    api,
    new CategorySuggestionOptimizer(new SimilarityCalculator()),
    tagService,
  );
  const transactionService = new TransactionService(
    api,
    categorySuggester,
    batchTransactionProcessor,
    transactionFilterer,
    true,
  );

  const wallStart = Date.now();
  await transactionService.processTransactions();
  const wallMs = Date.now() - wallStart;

  const snap = metrics.snapshot();
  console.log(`\n=== Dataset ${dataset.name} ===`);
  console.log(`transactions=${dataset.transactions.length} distinct_merchants=${dataset.payees.length}`);
  console.log(`wall_clock_ms=${wallMs} (concurrency=${concurrency}, ${llmLatencyMs}ms/call synthetic LLM latency${concurrency <= 1 ? ', includes the fixed inter-batch sleep' : ', no fixed sleep'})`);
  console.log(`llm_requests=${snap.llm_requests} llm_cache_hits=${snap.llm_cache_hits} transactions_processed=${snap.transactions_processed}`);
  console.log(`llm_prompt_chars_total=${snap.llm_prompt_chars_total} (avg ${snap.llm_requests > 0 ? Math.round(snap.llm_prompt_chars_total / snap.llm_requests) : 0} chars/request)`);
  console.log(`actual_read_calls=${snap.actual_read_calls}`);
  console.log(`category_suggestions_raw=${snap.category_suggestions_raw} unique=${snap.category_suggestions_unique} merged=${snap.category_suggestions_merged}`);
  console.log(`existing_category_count=${snap.existing_category_count} categories_created=${snap.categories_created} categories_reused=${snap.categories_reused}`);
  console.log(`existing_group_count=${snap.existing_group_count} groups_created=${snap.groups_created}`);
  console.log(`category_creation_ms=${snap.category_creation_ms} transaction_update_ms=${snap.transaction_update_ms}`);
}

async function main(): Promise<void> {
  // 0ms LLM latency: isolates real algorithmic overhead (prompt building, the fixed
  // 2000ms inter-batch sleep, category planning) from any assumption about model
  // speed. Pass --latency=<ms> to also see call-count-bound wall clock at a chosen
  // per-call cost.
  const latencyArg = process.argv.find((a) => a.startsWith('--latency='));
  const llmLatencyMs = latencyArg ? Number(latencyArg.split('=')[1]) : 0;
  const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : 1;

  const datasets = [
    buildDataset('A', 100, 50, 10, 1),
    buildDataset('B', 500, 200, 50, 2),
    buildDataset('C', 1000, 60, 100, 3), // high duplicate rate: 1000 tx over 60 merchants
  ];

  console.log(`Benchmark harness — synthetic LLM latency: ${llmLatencyMs}ms/call, concurrency=${concurrency}`);
  // eslint-disable-next-line no-restricted-syntax
  for (const dataset of datasets) {
    // eslint-disable-next-line no-await-in-loop
    await runDataset(dataset, llmLatencyMs, concurrency);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
