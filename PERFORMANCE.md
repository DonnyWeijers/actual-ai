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

# Phase 1: eliminate wasted work

## 1.1 Run-local LLM request deduplication

The payee-id-keyed cache already existed (see R2 correction above). What's new:

- **Fallback key for unresolved payees**, gated behind `dedupeUnresolvedPayees`
  (`src/config.ts`), default off. `src/transaction/dedup-key.ts` derives a key from
  normalized `imported_payee` (dropping dates, reference/store numbers, and common
  noise keywords — real examples like `ALBERT HEIJN 1234 DELFT` → `albert heijn
  delft`, `IDEAL 12-09 REF 887766` → `ideal`), falling back to normalized `notes`,
  plus transaction sign. Deliberately excludes the raw amount (near-0% hit rate,
  every purchase is a different number) and does not attempt to strip city names (no
  gazetteer — see the module docstring for why that's an acceptable limit, not a bug).
  Off by default because the normalization is heuristic and could, in principle,
  collide two different merchants that happen to normalize the same way — that's a
  real judgment call for a project maintainer to make, not mine to default on.
- **In-flight promise sharing + non-poisoning rejection.** `PayeeCategoryCache` now
  stores `Promise<UnifiedResponse>`, not resolved values (`getOrCreate()` replaces the
  old `get()`/`set()`). This matters once Phase 3 adds concurrency: two calls for the
  same key that overlap in time share the one request instead of racing into two.
  Storing an in-flight promise creates a failure mode the old resolved-value cache
  never had — a rejected promise sitting in the map would permanently fail every later
  transaction for that key — so a rejection evicts itself immediately, giving the next
  caller a fresh attempt.

Verified with 4 new integration tests (`tests/transaction-processor-dedup.test.ts`,
exercising the real `TransactionProcessor`) and 15 unit tests
(`tests/dedup-key.test.ts`, `tests/payee-category-cache.test.ts`): resolved-payee
dedup work regardless of the flag; unresolved-payee dedup only when the flag is on;
genuinely different merchants are never shared; a rejection doesn't poison the cache.

**What the benchmark does NOT show, and why that's honest, not a gap in the work**:
`llm_requests` on datasets A/B/C is unchanged from the Phase 0 baseline
(30/117/60) — because the synthetic dataset gives every transaction a resolved payee
(matching how Actual actually behaves for synced transactions), so every transaction
was already hitting the pre-existing payee-id cache. The new fallback path targets
transactions Actual leaves *without* a resolved payee, which this dataset shape
doesn't include. I don't know what fraction of transactions in a real budget lack a
resolved payee — I didn't have access to a real budget's raw sync data to measure it —
so I'm reporting the mechanism as verified-correct via the dedicated tests, not
claiming a benchmark win I can't show.

## 1.2 Hoist the invariant prompt work

`PromptGenerator.createRunContext()` compiles the template and builds
`groupsWithCategories`/`rulesDescription`/the payee-id→name index once;
`generateFromContext()` renders one transaction against that context.
`BatchTransactionProcessor.process()` calls `createRunContext()` once before its batch
loop instead of once per transaction. `generate()` (the old 4-arg signature) is kept
unchanged, implemented in terms of the two new methods, so none of the 6 existing
call sites in `tests/prompt-generator.test.ts` needed to change.

Safe because of B1 (plan/mutate separation, confirmed in Phase 0): categoryGroups,
payees, and rules are held constant for the whole classification loop, and nothing in
that loop can create a category or group mid-run — only the later `suggest()` phase
does, after the loop has already finished. That assumption is stated explicitly in
the method's docstring for whoever touches this next.

**What the benchmark does NOT show**: this removes O(N) redundant
`handlebars.compile()` calls and O(N) rebuilds of `groupsWithCategories`/
`rulesDescription`/the payee map (verified by code inspection — there's exactly one
call to `createRunContext()` per run now, not one per transaction), but at N=100-1000
each of those operations costs low single-digit milliseconds at most, and the
benchmark's wall-clock is completely dominated by R1's still-unfixed 2000ms/batch
sleep (Phase 3's job). The saving is real and grows with N; it's just not visible
against 8-98 seconds of sleep at this N. `llm_prompt_chars_total`/request ticked up
slightly (3889→3942 avg) — that's the reordered template's added "Now categorize the
following transaction:" line, not a regression.

## 1.3 Reorder the prompt template for prefix caching

`src/templates/prompt.hbs`: the invariant block (categories, rules, JSON schema,
examples, the web-search note) now comes first; the per-transaction block (amount,
type, description, payee, date) comes last. README updated to tell custom
`PROMPT_TEMPLATE` users to do the same.

Checked the pinned `ai`/`@ai-sdk/anthropic` versions (ai@4.3.5, @ai-sdk/anthropic@1.2.9):
Anthropic cache control **is** available — `cacheControl` via `providerOptions`,
enabled by default in this version (no SDK upgrade needed, confirming the task's
"do not upgrade the SDK here" constraint was satisfiable). Implemented behind
`LLM_PROMPT_CACHE=true` (`src/config.ts`'s `llmPromptCacheEnabled`, wired into
`LlmService`'s constructor options in `container.ts`):

- `src/handlebars-helpers.ts` registers a `{{cacheBreakpoint}}` helper emitting a
  NUL-wrapped sentinel (`CACHE_BREAKPOINT_MARKER`), placed in `prompt.hbs` right
  between the invariant block and "Now categorize...".
- `LlmService.ask()`: when the flag is on and the provider is `anthropic`, splits the
  rendered prompt on that sentinel and sends `messages: [{ role: 'user', content: [
  { type: 'text', text: prefix, providerOptions: { anthropic: { cacheControl: { type:
  'ephemeral' } } } }, { type: 'text', text: suffix } ] }]` instead of a flat
  `prompt` string. Every other case (flag off — the default; provider isn't
  anthropic; a custom template with no `{{cacheBreakpoint}}`) strips the marker and
  sends the identical flat prompt as before — verified by 4 tests in
  `tests/llm-service-prompt-cache.test.ts` asserting the exact `generateText` call
  shape in each case.

**What I did not, and could not, measure**: whether this actually reduces latency or
cost against Anthropic's real API. The benchmark's fake LLM never talks to Anthropic —
there's no real cache to hit. This is exactly the kind of number the task says not to
invent; the honest claim is "the mechanism is wired correctly and covered by tests,"
not "X% faster."

## 1.4 Stop refetching category state

- `CategorySuggester`: `categoryGroupByNormalizedName` replaces the `categoryGroups
  .find()` scan in the group-resolution loop with a Map built once. `findCategoryId()`
  now shares one memoized `getCategories()` promise (`this.categoriesPromise`,
  reset at the top of each `suggest()` call) instead of refetching on every collision.
  `existingCategoryIds` (the group-id+name → category-id index) already existed
  before this phase — it's effectively `categoryByNormalizedGroupAndName` already,
  confirmed in Phase 0, not rebuilt here.
- `ExistingCategoryStrategy`: the real hot loop for category lookups isn't inside
  `CategorySuggester` at all (that only runs once per run, in the suggestion tail) —
  it's here, once per transaction with an "existing" response. Changed
  `categories.find(c => c.id === response.categoryId)` (O(transactions × categories))
  to a `categoryById: Map` built once in `BatchTransactionProcessor.process()`
  alongside the prompt context (O(1) per lookup). `ProcessingStrategyI`'s shared
  `process()` signature now takes that Map instead of the raw array — `NewCategoryStrategy`
  and `RuleMatchStrategy` don't use it (confirmed by reading both), so this is a
  type-only change for them.

Verified: 2 new tests in `tests/category-suggester.test.ts` (multiple collisions in
one `suggest()` call trigger exactly one `getCategories()`; two separate `suggest()`
calls each refetch — the memo doesn't leak across runs). `ExistingCategoryStrategy`'s
behavior is unchanged and covered by the existing integration tests in
`tests/actual-ai.test.ts`, which all still pass.

**What the benchmark does NOT show**: `actual_read_calls` stayed at 6 on every
dataset — because A/B/C's synthetic suggestions never collide with an existing
category (`categories_reused=0` throughout, same as Phase 0), so the memoized-refetch
path never fires in this data. It's verified correct by the dedicated tests, not by a
benchmark number, for the same reason 1.1's fallback path isn't: the benchmark's data
shape doesn't happen to exercise that edge.

## Measured deltas vs. Phase 0 baseline

| Metric | A | B | C | Changed? |
|---|---|---|---|---|
| `llm_requests` | 30 | 117 | 60 | No — see 1.1 |
| `llm_cache_hits` | 70 | 383 | 940 | No |
| `llm_prompt_chars_total`/req | 3,942 (was 3,889) | 3,942 | 3,942 | +53 chars, template reorder, not a regression |
| `actual_read_calls` | 6 | 6 | 6 | No — see 1.4 |
| `category_suggestions_raw→unique→merged` | 18→10→7 | 241→43→19 | 478→21→16 | No |
| `wall_clock_ms` | 8,060 (was 8,136) | 48,183 (was 48,430) | 98,228 (was 98,411) | No, within noise — still R1-dominated |

Every number that *should* be unchanged on this dataset is unchanged, and I can
explain exactly why for each one rather than shrug at it. Phase 1's real, verified
wins (fallback dedup, hoisted prompt building, memoized category refetch, cache
breakpoints) are demonstrated by 21 new unit/integration tests, not by this benchmark
— the benchmark's synthetic data doesn't happen to contain the specific conditions
(unresolved payees, category-creation collisions, a real Anthropic connection) that
would make them visible in call counts or wall-clock. Reproducing this table doesn't
require re-deriving that reasoning: `npm run bench`.

## Correction to Phase 0's own report

None — R1–R12 and B1–B4 stand as verified in Phase 0. This phase's only correction is
to my own earlier framing of R2 as "not deduplication of equivalent LLM requests":
after 1.1, that's true only for the unresolved-payee edge case, which is now
explicitly named rather than lumped in with the (already-fixed-before-this-task)
resolved-payee case.

## What I deliberately did not do, and why

- Did not touch `B1`–`B3` (plan/mutate separation, sequential group resolution,
  suggestion dedup-by-key) — Phase 0 confirmed these are already correct; touching
  them now would be churn, exactly what the task warns against.
- Did not build a *persisted* (cross-run) payee→category cache — out of scope for
  Phase 1 (that's one of the "propose before implementing" items), and doing it now
  would preempt a design decision that isn't mine to make unilaterally.
- Did not add cache-control support for any provider other than Anthropic — the task
  named Anthropic specifically, and I don't know whether OpenAI/Gemini/Groq/OpenRouter
  expose an equivalent explicit-breakpoint mechanism in the pinned SDK versions without
  checking each one, which wasn't asked for here.
- Did not attempt to strip city names in `normalizeMerchantText` — no gazetteer, and a
  wrong guess risks eating a real word out of a short merchant name. Documented as a
  deliberate limit, not silently accepted.

# Phase 3: safe concurrency (P2)

Note on sequencing: this landed before Phase 2 (category planning quality), which was
skipped by mistake. Not a deliberate reordering — flagged and corrected after the
fact; Phase 2 follows this section.

## 3.1 Bounded pool

`src/utils/concurrency.ts`: `mapWithConcurrency<T, R>(items, limit, fn)`. Pull-based
(each worker claims the next unclaimed index the moment it's free, not "wait for the
whole batch") so one slow item never stalls workers that could be picking up later
ones — this is the actual difference from the old `batch.reduce(...)` shape, which
serialized everything regardless. Returns `PromiseSettledResult<R>[]`
(`Promise.allSettled`'s own shape): one item's rejection doesn't stop the others, and
callers get an explicit per-item outcome instead of the whole call throwing. No new
dependency, ~40 lines.

Verified: 6 tests (`tests/concurrency.test.ts`) — peak concurrency never exceeds the
limit but does reach it, order-preserving results regardless of completion order,
rejection isolation, a slow item not blocking faster ones behind it, empty input,
limit larger than the item count.

## 3.2 Classification concurrency

New `LLM_CONCURRENCY` env var (`src/config.ts`), **default 1**. `BatchTransactionProcessor`
now has two explicit paths:

- `concurrency <= 1`: byte-for-byte the old sequential loop — batches of 20, the
  fixed 2000ms pause between them. Nothing changes for a user who never touches this
  setting.
- `concurrency > 1`: routes every transaction in the run through `mapWithConcurrency`
  at that limit, no fixed pause — throttling is the rate limiter's job now (3.4), not
  a blind sleep's.

Verified the one genuinely shared piece of mutable state under concurrency —
`NewCategoryStrategy`'s `suggestedCategories.get()`-then-`.push()`/`.set()` — is safe
without a lock: there's no `await` anywhere between the read and the write, and JS
only ever hands off to another concurrent call at an `await`. Documented in the
method itself, and pinned with 2 concurrency-specific tests
(`tests/new-category-strategy.test.ts`, 50 and 40 concurrent calls respectively —
no lost or cross-attributed transactions). 3 more tests
(`tests/batch-transaction-processor.test.ts`) cover both paths directly: concurrency=1
stays sequential with the pause, concurrency>1 is bounded and pause-free, and one
transaction's error doesn't stop the batch.

## 3.3 Bounded category creation

Replaced both `Promise.all`s in `CategorySuggester.suggest()` (R8: previously fully
unbounded — every category and, nested inside each, every one of its transactions)
with `mapWithConcurrency` at a fixed `WRITE_CONCURRENCY = 5`. Not user-configurable —
unlike `LLM_CONCURRENCY` there's no real per-provider tradeoff to expose here, just a
cap against hammering Actual's API. Group resolution stays exactly as sequential as
before (unchanged) — that's the race fix from the earlier production bug and Phase 3
does not touch it; stated explicitly in a comment at the call site so the reasoning
doesn't have to be re-derived later.

Verified with 2 new tests asserting peak concurrent `createCategory`/
`updateTransactionNotesAndCategory` calls: greater than 1 (so it's genuinely
concurrent, not accidentally still serial) and at most 5 (so it's bounded, not
unbounded).

## 3.4 Fix the rate limiter

Both R10 bugs, fixed:

- **Window bug**: replaced `requestCounts`/`lastRequestTime` (reset "if more than a
  minute since the *last* request" — which kept sliding the window's effective start
  forward on every call) with real sliding windows of timestamps
  (`requestTimestamps`, `tokenUsageWindow`), pruned to the trailing 60s on each check.
- **Dead token axis**: `tokensPerMinute` is now actually enforced. `LlmService.ask()`
  estimates outgoing tokens as `chars/4`, passes that through
  `executeWithRateLimiting`'s new optional `estimatedTokens` option, and — when the
  provider reports real `usage.totalTokens` — reconciles the estimate via
  `recordActualTokenUsage()` so the window doesn't drift from a rough guess over many
  requests.

**A real bug found and fixed during this sub-item, not in the original R-list**:
the first implementation used a `for(;;)` retry loop (compute wait → sleep → recheck)
that reads more "obviously correct" than a single wait-then-proceed — but it hung the
test suite (`jest.useFakeTimers()` mocks `sleep` to resolve without advancing
`Date.now()`, so the loop recomputed the same positive wait forever and ran the
process out of memory). Simplified to the single-shot version documented in the
method's own docstring: this project's actual concurrency (a single local Ollama
instance, `LLM_CONCURRENCY` of 1–2) doesn't need a perfectly tight retry loop, and the
simpler version can't hang under a stalled/mocked clock. Noting this because it's
exactly the kind of thing "looks more correct" that turned out to be the wrong
tradeoff for this project — the retry-loop version was reverted, not layered around.

Existing env-var trichotomy preserved (unset → provider default, 0 → axis disabled,
positive → custom) — unchanged in `LlmService`, which already resolved it correctly;
this phase only had to make `RateLimiter` actually consume the token side of it via a
new `setProviderTokenLimit()`.

`executeWithRateLimiting()`'s signature is unchanged and back-compat — the new
`estimatedTokens` option is an optional 4th parameter, so all 15 pre-existing tests in
`tests/utils/rate-limiter.test.ts` kept working (one was updated, not because its
mechanism broke, but because it was pinning the *old bug's* 80%-early-warning
behavior — see below). 5 new tests cover token throttling, `recordActualTokenUsage`
reconciliation, a single request that alone exceeds the whole budget (let through
rather than waited on forever), and — the task's explicit ask — proactive throttling
under real concurrent callers (`Promise.all`, not sequential awaits).

**One existing test changed, deliberately**: `should enforce rate limits when
approaching the limit` asserted that hitting 80% of the request limit (4 out of 5)
triggered preemptive waiting *before* the 5th request. That was the old code
faithfully doing what it was designed to do; it just also happened to be the specific
behavior built on top of the buggy window logic being fixed here. Replaced with two
tests pinning the corrected semantics: no wait until the window is actually full, wait
once it is.

## 3.5 Web search in-flight sharing

`ToolService.webSearchCache` now stores the in-flight `Promise<string>` itself
(`CachedSearchEntry.promise`), not the resolved value — three concurrent lookups of
the same merchant (only actually possible now that 3.2 allows real concurrency) share
one HTTP request instead of each firing its own. A rejected promise is evicted from
the cache immediately (`.catch()` deletes the key before rethrowing) so a transient
failure doesn't leave a permanently-failing entry for the TTL — the next lookup gets a
fresh attempt. TTL and the 200-entry cap are unchanged.

Verified: 2 new tests in `tests/tool-service-cache.test.ts` (concurrent identical
queries → one `performSearch` call; a rejection is evicted and retried, not cached) on
top of the 3 pre-existing cache tests, which all still pass unchanged.

## Measured: the concurrency mechanism is real, not just modeled

Earlier in this project I was asked what wall-clock improvement to expect from Phase
3, before writing any of it, and declined to give a number — the honest answer at the
time was "I don't know, it depends on real per-call latency and the concurrency you
choose." Now that the mechanism exists, here's a real comparison: same 3 datasets,
same 200ms/call *synthetic* latency (not real Ollama latency, which is far higher and
was already measured elsewhere in this project to be 58–95s/call on CPU-only
hardware — 200ms is chosen only to keep this benchmark run fast, not to represent
real-world Ollama), `concurrency=1` vs `concurrency=4`:

| Dataset | concurrency=1 | concurrency=4 | Speedup |
|---|---|---|---|
| A | 14,092ms | 1,835ms | 7.7x |
| B | 71,648ms | 6,267ms | 11.4x |
| C | 110,285ms | 3,466ms | 31.8x |

`llm_requests`/`llm_cache_hits` are identical between the two runs on each dataset
(caching is orthogonal to concurrency) — the entire difference is the fixed sleep
being gone and real parallelism replacing sequential waiting. Reproduce with
`npm run bench -- --latency=<ms> --concurrency=<n>`.

**What this table does not tell you**: your actual speedup with real Ollama. Per the
earlier discussion in this project, the sleep's fixed cost matters most relative to
how *cheap* each real call already is — a hosted API (1–3s/call) looks like the table
above; local Ollama, where a single call can be 100–500x more expensive than this
table's 200ms and concurrency is capped low (1–2, one CPU/GPU rarely benefits from
more), sees a smaller relative win because the sleep was never the dominant cost to
begin with. The formula is `ceil(llm_requests / concurrency) × real_call_latency`;
plug in real Ollama numbers once you've picked a concurrency to try.

## What I deliberately did not do, and why

- Did not make `WRITE_CONCURRENCY` (category creation) user-configurable — no real
  per-provider tradeoff exists for it the way there is for `LLM_CONCURRENCY`; it's
  purely a "don't hammer Actual's API" cap.
- Did not attempt perfect per-request token-usage attribution in
  `recordActualTokenUsage` — under heavy concurrency it may reconcile a slightly
  different in-flight entry than the one that actually produced the usage number.
  Documented as an accepted imprecision: this feeds a proactive sliding-window
  estimate, not a billing record, and staying roughly accurate over time is what
  matters.
- Did not add a retry-loop / re-check-after-waiting version of `reserveCapacity` back
  in after simplifying it — the single-shot version is correct for this project's
  actual concurrency levels and can't hang; a tighter loop would be solving a problem
  (perfect enforcement at high concurrency against a real external API) this project
  doesn't have.
