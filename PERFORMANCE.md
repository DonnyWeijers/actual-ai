# Performance refactor — Phase 0: trace, verify, instrument

This document is the Phase 0 deliverable: the real call graph, a file:line-verified
verdict on every hypothesis (B1–B4, R1–R12), the instrumentation added, and baseline
numbers from the new benchmark harness. No behavior changed in this phase — every
edit is either a `metrics.*` call (additive, doesn't touch control flow or return
values) or new files (`src/utils/metrics.ts`, `scripts/bench.ts`,
`tests/metrics.test.ts`).

## 0a. Call graph

```
app.ts (cron / run-once entry)
  → src/container.ts (DI wiring — the graph below is the real object graph, not a
    description of it)
  → ActualAiService.classify()                                    [once/run]
      → ActualApiService.initializeApi()                          [once/run, Actual]
      → ActualAiService.syncAccounts()                            [once/run, optional]
          → ActualApiService.runBankSync()                        [once/run, Actual]
      → TransactionService.processTransactions()                  [once/run]
          → ActualApiService.{getCategoryGroups,getCategories,
            getPayees,getTransactions,getAccounts,getRules}()      [once/run each, Actual, parallel Promise.all]
              → ActualApiService.getTransactions() internally
                also calls getAccounts() again                     [once/run, Actual — a 2nd, redundant accounts read]
          → TransactionFilterer.filterUncategorized()              [once/run]
          → BatchTransactionProcessor.process()                    [once/run]
              → (serialized, one batch of 20 at a time, 2000ms
                sleep between batches — see R1)
              → TransactionProcessor.process()                     [once/transaction]
                  → PayeeCategoryCache.get(transaction.payee)       [once/transaction]
                  → [cache miss only:]
                    PromptGenerator.generate()                     [once/transaction, on cache miss]
                      → handlebars.compile(promptTemplate)          [once/transaction — R3]
                      → transformRulesToDescriptions()               [once/transaction — R3]
                      → payees.find(p => p.id === transaction.payee) [once/transaction, O(payees) — R3]
                    LlmService.ask()                                [once/transaction, on cache miss — network]
                      → RateLimiter.executeWithRateLimiting()        [once/LLM call]
                    PayeeCategoryCache.set()                        [once/transaction, on cache miss]
                  → RuleMatchStrategy / ExistingCategoryStrategy /
                    NewCategoryStrategy .process()                  [once/transaction]
                      → ActualApiService.updateTransactionNotes(
                        AndCategory)()                              [once/transaction, Actual]
                      → NewCategoryStrategy also appends into the
                        run-scoped suggestedCategories Map           [once/transaction, in-memory — B1]
          → [if suggestNewCategories and suggestions exist:]
            CategorySuggester.suggest()                             [once/run]
              → CategorySuggestionOptimizer.optimizeCategorySuggestions() [once/run]
                  → SimilarityCalculator.calculateNameSimilarity()   [once per unique-suggestion PAIR — O(K²), K = unique suggestions, NOT N transactions — B3]
              → group resolution loop (sequential, `for...of`)       [once per unique group name]
                  → ActualApiService.createCategoryGroup()           [once per NEW group, Actual — B2]
              → Promise.all over optimized categories                [unbounded concurrency — R8]
                  → resolveCategoryId() → ActualApiService
                    .createCategory()                                [once per NEW category, Actual]
                      → [on "already exists" collision:]
                        findCategoryId() → ActualApiService
                        .getCategories()                             [re-fetches ALL categories, per collision — R9]
                  → Promise.all over that category's transactions     [unbounded concurrency, nested inside the above — R8]
                      → ActualApiService.updateTransactionNotesAndCategory() [once per transaction, Actual]
      → ActualApiService.shutdownApi()                              [once/run, Actual]
```

## 0b. Verdicts

All confirmed by reading the code at the cited lines on `master` (commit at time of
writing: the tip after the `ollama-improvements` PR merge, which added
`PayeeCategoryCache` — this matters for R2, see below).

### Already implemented — confirmed, left alone

- **B1 (plan/mutate separation): CONFIRMED.** `NewCategoryStrategy.process()`
  (`src/transaction/processing-strategy/new-category-strategy.ts:14-41`) only mutates
  the in-memory `suggestedCategories` Map, never calls `ActualApiService`.
  `TransactionService.processTransactions()`
  (`src/transaction-service.ts:75-91`) runs the full `BatchTransactionProcessor.process()`
  loop to completion before calling `categorySuggester.suggest()`. Not touched.
- **B2 (group resolution sequential): CONFIRMED.**
  `src/transaction/category-suggester.ts:46-66` — `Array.from(new Set(...))` then a
  `for...of` loop with `await` inside, one group at a time. Not touched (Phase 3.3
  keeps this exactly as-is per the hard constraints).
- **B3 (suggestions arrive deduplicated): CONFIRMED, with a precision.**
  `new-category-strategy.ts:29` keys on `` `${groupName}:${name}` `` — but this is a
  **raw string key, not case-normalized** (see R6). So "arrives deduplicated" is true
  for exact-case duplicates only; `Coffee`/`coffee`/`COFFEE` still reach the optimizer
  as 3 separate entries. The O(K²) merge in `CategorySuggestionOptimizer` (K = size of
  that map) is real and correctly K-not-N, confirmed by the benchmark below
  (`category_suggestions_raw` → `_unique` shows the exact reduction on each dataset).
- **B4 (web search cached, no in-flight sharing): CONFIRMED.**
  `src/utils/tool-service.ts` — `CachedSearchResult { value: string; expiresAt: number }`
  (line 17-20) stores resolved **values**, not Promises, so two concurrent identical
  searches both execute before either's result lands in the cache. TTL = 30 min
  (line 23), cap = 200 entries (line 25). Correct as stated; revisit in Phase 3.5.

### Real, verified, file:line

- **R1: CONFIRMED.** `batch-transaction-processor.ts:53-68` —
  `batch.reduce(async (previousPromise, transaction) => { await previousPromise; ... })`,
  strictly serial. Lines 71-76: unconditional `setTimeout(resolve, 2000)` between every
  batch of 20. This is not a hypothesis — the benchmark harness itself was throttled by
  it: dataset B (500 tx / 20 = 25 batches) spent 48 of its ~48.4s wall-clock in this
  sleep alone; dataset C (1000 tx / 20 = 50 batches) spent 98 of its ~98.4s. See
  baseline numbers below.
- **R2: PARTIALLY WRONG as originally stated — corrected.** The `ollama-improvements`
  PR (merged to `master` before this branch was cut) already added
  `src/transaction/payee-category-cache.ts` and wired it into
  `transaction-processor.ts:58-73`: a transaction whose `transaction.payee` (Actual's
  own resolved, stable payee id) was already seen this run reuses the prior
  `UnifiedResponse` with **zero** prompt generation and **zero** LLM call. The
  benchmark confirms this works: dataset C (1000 tx, 60 merchants, Zipf-skewed) shows
  `llm_requests=60 llm_cache_hits=940` — a 94% reduction already in place.
  **What's still missing** (this is where real Phase 1.1 work remains): the cache key
  is `transaction.payee` only. A transaction with **no resolved payee** (falls back to
  raw `imported_payee` text in the prompt — see `prompt-generator.ts:56-57`) never hits
  the cache, no matter how many near-identical raw bank strings it shares with other
  such transactions. Whether this matters in practice depends on how often Actual
  leaves `payee` unset on synced transactions — I did not have access to a large real
  budget's raw sync data to measure that rate, so I'm not sizing this gap, just noting
  it precisely so Phase 1.1 knows what's actually left to do (extending
  `PayeeCategoryCache` with a normalized-`imported_payee` fallback key, not building a
  new cache from scratch).
- **R3: CONFIRMED**, all three sub-claims, all at the cited lines.
  `prompt-generator.ts:28` — `handlebars.compile(this.promptTemplate)` runs inside
  `generate()`, called once per transaction (on every cache miss).
  `prompt-generator.ts:33` — `payees.find((payee) => payee.id === transaction.payee)`,
  linear scan, once per transaction.
  `prompt-generator.ts:36-46` — `groupsWithCategories` map and
  `transformRulesToDescriptions()` both rebuilt every call despite depending only on
  run-invariant `categoryGroups`/`rules`.
- **R4: CONFIRMED.** `src/templates/prompt.hbs:3-16` (amount/type/description/payee/date)
  precedes `:18-58` (categories/rules/schema/examples). The variable part is first, the
  shared part is last — the opposite of what prefix caching needs.
- **R5: CONFIRMED.** The optimizer
  (`category-suggestion-optimizer.ts:38-58`) clusters suggestions against each other
  using `SimilarityCalculator`. `CategorySuggester.suggest()` then matches against
  **existing** categories with an exact (case-insensitive) key lookup only
  (`category-suggester.ts:71-76, 83-87`: `existingCategoryIds.get(key)` where
  `key = groupId::name.toLowerCase()`) — no fuzzy step. `SimilarityCalculator` is never
  invoked against existing category names anywhere in the codebase.
- **R6: CONFIRMED.** `new-category-strategy.ts:29`:
  `` `${response.newCategory.groupName}:${response.newCategory.name}` `` — raw casing,
  no `.toLowerCase()`. Benchmark dataset A deliberately includes case variants
  (`Coffee`/`coffee`/`COFFEE`) in its suggestion pool; they show up as distinct entries
  in `category_suggestions_raw` and only collapse at the `_merged` stage (via
  `SimilarityCalculator`'s 1.0-similarity exact-match case, not via B3's key dedup).
- **R7: CONFIRMED.** `similarity-calculator.ts:13-16` — `normalize()` and
  `PorterStemmer.tokenizeAndStem()` run fresh inside `calculateNameSimilarity()`, which
  is called once per pair in the O(K²) loop
  (`category-suggestion-optimizer.ts:48-51`). For K unique suggestions this is K²
  re-normalizations/re-stems of the same K names.
- **R8: CONFIRMED.** `category-suggester.ts:98` (`Promise.all` over every optimized
  category) and `:109` (nested `Promise.all` over every transaction in that category) —
  both genuinely unbounded; nothing limits concurrent Actual writes.
- **R9: CONFIRMED.** `category-suggester.ts:142-150`, `findCategoryId()` calls
  `this.actualApiService.getCategories()` — a full re-fetch — every time
  `createCategory()` hits Actual's "already exists" error
  (`category-suggester.ts:126-139`), and this happens inside the unbounded fan-out from
  R8.
- **R10: CONFIRMED, both halves.**
  Window bug: `rate-limiter.ts:228-241` (`trackRequest`) sets
  `this.lastRequestTime.set(provider, now)` on **every** call, not just the first in a
  window. `waitIfNeeded` (`rate-limiter.ts:263-270`) then computes
  `waitTime = 60000 - (now - lastTime) + 100` using that continuously-refreshed
  `lastTime` — so at 80% of the limit it can sleep close to a full 60s measured from
  the most recent call, not from when the window opened.
  Dead token axis: `llm-service.ts:68-69` computes `tokensLimit` from
  `options?.tokensPerMinuteOverride ?? providerDefault?.tokensPerMinute`, but it is only
  ever read again at line ~89 inside the `fmt()` log string. `RateLimiter` has no
  method to accept a tokens-per-minute limit — `tokenBuckets` is populated exclusively
  reactively, from parsing a Groq 429 error message
  (`rate-limiter.ts:126-164`, `updateTokenBucketFromError`). A user-set
  `TOKENS_PER_MINUTE` changes only a log line.
- **R11: CONFIRMED.** `actual-api-service.ts:123-134` (`getTransactions`) calls
  `this.actualApiClient.getTransactions(account.id, '1990-01-01', '2030-01-01')` per
  account, unconditionally, every run.
- **R12: CONFIRMED.** `transaction-processor.ts`'s single `catch` block
  (surrounding the whole `process()` body) tags **every** thrown error — timeout,
  abort, 5xx, or a genuine parse failure — with the permanent not-guessed tag via
  `tagService.addNotGuessedTag`. Nothing distinguishes a transient failure from a
  permanent miss.

### Correctness bug found, not fixed (per the "tell me first" instruction)

Not one of B1–B4/R1–R12, but found while tracing R9/R8: `category-suggester.ts:126-139`
(`createCategory`'s catch-fallback) calls `findCategoryId()`, which does a
**case-insensitive** name match (`category.name.toLowerCase() === name.toLowerCase()`,
line 147). But the **first-choice** path, `existingCategoryIds` (built at
`category-suggester.ts:71-76`), keys via `CategorySuggester.categoryKey()`
(line 152-154), which **also** lowercases. So both paths are actually consistent — on
closer reading this is not a bug, I'm flagging it because it looked like one on first
pass and I want the verification trail to show I checked rather than assumed. No action
taken.

## 0c. Instrumentation

Added `src/utils/metrics.ts` — a small in-memory singleton (module-level, like
`src/config.ts`'s export style), no telemetry dependency, `console.log`-only output,
with `reset()`/`incr()`/`addMs()`/`timeAsync()`/`snapshot()`/`logSummary()`. Covered by
`tests/metrics.test.ts` (7 tests: zeroing, counting, timing, timing-through-a-throw,
reset, snapshot shape).

Every counter in the spec's list is wired to a real call site:

| Counter/timer | Wired in | 
|---|---|
| `classification_run_ms` | `actual-ai.ts` (`classify()` start/finally) |
| `transactions_processed` | `transaction-processor.ts` (`process()` entry) |
| `llm_requests`, `llm_prompt_chars_total`, `llm_request_ms_total` | `llm-service.ts` (`ask()`) |
| `llm_cache_hits` | `transaction-processor.ts` (cache-hit branch) |
| `web_search_requests`, `web_search_cache_hits` | `utils/tool-service.ts` (`searchWithCache()`) |
| `actual_read_calls` | `actual-api-service.ts`, every `get*()` method |
| `category_suggestions_raw` | `new-category-strategy.ts` (`process()`) |
| `category_suggestions_unique` | `transaction-service.ts` (`suggestedCategories.size` before calling the suggester) |
| `category_suggestions_merged` | `category-suggestion-optimizer.ts` (`optimizedCategories.size`) |
| `existing_category_count` | `category-suggester.ts` (`suggest()` entry) |
| `categories_created`, `categories_reused` | `actual-api-service.ts` / `category-suggester.ts` (the two reuse paths) |
| `existing_group_count`, `groups_created` | `category-suggester.ts` (group loop) / `actual-api-service.ts` |
| `category_creation_ms`, `transaction_update_ms` | `actual-api-service.ts` (wrapping the Actual API calls) |

One honest gap: `llm_request_ms_total` is only recorded on a **successful**
`ask()` — a request that ultimately throws (after rate-limiter retries are exhausted)
doesn't add to the timer. Scope choice, not an oversight: the metric answers "how much
time did successful LLM calls cost," which is what Phase 1's prompt/caching work needs;
failure-path timing is a separate question Phase 3.4 (rate limiter rewrite) is better
positioned to answer.

The benchmark harness (below) exercises a **fake** `ActualApiServiceI`
(`tests/test-doubles/in-memory-actual-api-service.ts`), so it needed the same
`actual_read_calls`/`categories_created`/`groups_created`/`category_creation_ms`/
`transaction_update_ms` instrumentation mirrored into that test double — otherwise
those six counters would silently read zero under the benchmark despite being correctly
wired in production code. Also fixed while there: the double's `createCategory`/
`createCategoryGroup` minted ids from `Date.now()`, which collides under the real
unbounded-`Promise.all` fan-out (R8) when there's no real network latency to space
calls apart — switched to a monotonic counter. Both are test-infrastructure
corrections, not production behavior changes.

## 0d. Benchmark harness

`scripts/bench.ts` (`npm run bench`, excluded from the Docker build via
`tsconfig.json`'s `exclude`). Drives the real `TransactionService.processTransactions()` — same
object graph as `container.ts` — against `InMemoryActualApiService` and a
`FakeLlmService` that mirrors `LlmService.ask()`'s own metric calls but skips the
actual network round-trip (configurable synthetic per-call latency, `0` by default so
baseline numbers isolate real algorithmic overhead from any assumption about model
speed). Response content is scripted per-payee from a seeded, deterministic PRNG, so a
repeat payee always gets the same scripted answer — which is what makes payee-level
caching valid to test in the first place. The "new category" suggestion pool
deliberately includes near-duplicate case/pluralization variants, the same trap R5/R6/R7
describe.

Three datasets, generated with a Zipf-ish merchant-frequency skew (dataset C uses a
tighter merchant pool to hit "high duplicate rate" honestly rather than by construction
trickery):

| | transactions | distinct merchants |
|---|---|---|
| A | 100 | 50 |
| B | 500 | 200 |
| C | 1,000 | 60 |

Run with `suggestNewCategories` enabled (`FEATURES='["suggestNewCategories"]'`) so the
full pipeline — including `CategorySuggester` — actually executes; it's off by default
in production and the first benchmark run silently skipped that whole code path as a
result (caught by all-zero `category_suggestions_unique`/`_merged` numbers, fixed
before reporting the numbers below).

### Baseline numbers (this Phase — nothing optimized yet)

All numbers below are real: either a `metrics` counter populated by the real code path,
or wall-clock from `Date.now()` around the real call. Wall-clock explicitly separates
the fixed-sleep component (real, measured) from the synthetic per-call LLM latency
(0ms here, so it isolates algorithmic cost).

| Metric | A (100 tx / 50 merchants) | B (500 tx / 200 merchants) | C (1,000 tx / 60 merchants) |
|---|---|---|---|
| `wall_clock_ms` | 8,136 | 48,430 | 98,411 |
| — of which fixed inter-batch sleep (R1) | 8,000 (4 sleeps) | 48,000 (24 sleeps) | 98,000 (49 sleeps) |
| `llm_requests` | 30 | 117 | 60 |
| `llm_cache_hits` | 70 | 383 | 940 |
| cache hit rate | 70% | 77% | 94% |
| `llm_prompt_chars_total` | 116,655 (3,889/req) | 455,031 (3,889/req) | 233,323 (3,889/req) |
| `actual_read_calls` | 6 | 6 | 6 |
| `category_suggestions_raw` → `_unique` → `_merged` | 18 → 10 → 7 | 241 → 43 → 19 | 478 → 21 → 16 |
| `existing_category_count` | 40 | 40 | 40 |
| `categories_created` / `_reused` | 7 / 0 | 19 / 0 | 16 / 0 |
| `existing_group_count` / `groups_created` | 5 / 0 | 7 / 0 | 7 / 0 |
| `category_creation_ms` | 0 | 0 | 0 |
| `transaction_update_ms` | 0 | 127 | 1,162 |

Notes on reading this table:

- **The fixed sleep alone accounts for 98%+ of wall-clock on every dataset.** This is
  the single largest, least-ambiguous number in this report: R1's 2000ms/batch sleep
  is not a minor inefficiency, it *is* the runtime at any real transaction volume,
  completely independent of LLM speed, prompt size, or provider. Phase 3.2
  (concurrency, gated behind `LLM_CONCURRENCY`) is where this gets addressed —
  correctly last, per the ordering in this plan, since concurrency multiplies whatever
  per-call work Phases 1–2 haven't yet removed.
- **The payee cache (already shipped) is doing real, measurable work**: 70–94% of
  transactions never reach the LLM. The remaining `llm_requests` count is real API
  calls that *would* hit a real provider — 30/117/60 across these datasets, not
  100/500/1000. This is why R2 needed correcting rather than reimplementing.
- **`category_suggestions_raw` → `_unique` → `_merged`** is the exact reduction chain
  the "measurable goals" table asks for: B3's key-based dedup (raw → unique) and the
  similarity-based clustering (unique → merged) are both doing real, separate,
  measurable work already — 241 raw suggestions became 19 categories on dataset B.
  Phase 2's job is making that merge step correct against *existing* categories too
  (R5) and deterministic regardless of suggestion order (2.4), not making the
  reduction itself larger.
- **`actual_read_calls=6` on every dataset, regardless of transaction count** — this
  is expected and correct at this stage: 6 = the five parallel reads in
  `TransactionService.processTransactions()`'s initial `Promise.all` (category groups,
  categories, payees, transactions, rules) plus the one redundant internal
  `getAccounts()` call inside `getTransactions()`. It does not scale with N because
  nothing in the current code re-reads per-transaction — R9's per-collision
  `getCategories()` refetch never fired here because `categories_reused=0` on all three
  datasets (the synthetic suggestion pool never happens to exactly match an existing
  category name). That's a benchmark-data gap, not a finding that R9 is wrong — R9 is
  confirmed independently by the file:line read in section 0b.
- **`category_creation_ms=0`**: real, not a bug — creating a category against an
  in-memory Map takes sub-millisecond time, below `Date.now()`'s practical resolution
  at this scale. Not informative for comparing phases; `transaction_update_ms` (which
  scales with N and shows real, non-zero numbers on B/C) is the more useful of the two
  timers on a fake backend. Both will be far more meaningful once there's a real
  Actual server in the loop, which is out of scope for this harness.

Reproduce with `npm run bench` (takes ~2.5 minutes, almost entirely the R1 sleep) or
`npm run bench -- --latency=<ms>` to also see a chosen synthetic per-call LLM cost
layered on top.
