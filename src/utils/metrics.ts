/**
 * Lightweight run counters and timers, added in the Phase 0 performance-refactor pass
 * (see PERFORMANCE.md) to make wasted work measurable instead of guessed at. No
 * telemetry dependency: this is an in-memory singleton, reset per run/per test, and
 * only ever printed with console.log to match the project's existing logging style.
 *
 * Every call site that increments a counter is additive instrumentation only — it does
 * not change control flow, return values, or timing-sensitive behavior.
 */

interface Counters {
  transactions_processed: number;
  llm_requests: number;
  llm_cache_hits: number;
  llm_prompt_chars_total: number;
  web_search_requests: number;
  web_search_cache_hits: number;
  actual_read_calls: number;
  category_suggestions_raw: number;
  category_suggestions_unique: number;
  category_suggestions_merged: number;
  existing_category_count: number;
  categories_created: number;
  categories_reused: number;
  existing_group_count: number;
  groups_created: number;
}

interface Timers {
  classification_run_ms: number;
  llm_request_ms_total: number;
  category_creation_ms: number;
  transaction_update_ms: number;
}

type CounterName = keyof Counters;
type TimerName = keyof Timers;

function zeroCounters(): Counters {
  return {
    transactions_processed: 0,
    llm_requests: 0,
    llm_cache_hits: 0,
    llm_prompt_chars_total: 0,
    web_search_requests: 0,
    web_search_cache_hits: 0,
    actual_read_calls: 0,
    category_suggestions_raw: 0,
    category_suggestions_unique: 0,
    category_suggestions_merged: 0,
    existing_category_count: 0,
    categories_created: 0,
    categories_reused: 0,
    existing_group_count: 0,
    groups_created: 0,
  };
}

function zeroTimers(): Timers {
  return {
    classification_run_ms: 0,
    llm_request_ms_total: 0,
    category_creation_ms: 0,
    transaction_update_ms: 0,
  };
}

class Metrics {
  private counters: Counters = zeroCounters();

  private timers: Timers = zeroTimers();

  public reset(): void {
    this.counters = zeroCounters();
    this.timers = zeroTimers();
  }

  public incr(name: CounterName, by = 1): void {
    this.counters[name] += by;
  }

  public addMs(name: TimerName, ms: number): void {
    this.timers[name] += ms;
  }

  /** Wraps an async operation, adding its wall-clock duration to the named timer. */
  public async timeAsync<T>(name: TimerName, op: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await op();
    } finally {
      this.addMs(name, Date.now() - start);
    }
  }

  public get(name: CounterName | TimerName): number {
    if (name in this.counters) {
      return this.counters[name as CounterName];
    }
    return this.timers[name as TimerName];
  }

  public snapshot(): Counters & Timers {
    return { ...this.counters, ...this.timers };
  }

  public logSummary(): void {
    const all = this.snapshot();
    console.log('--- Run metrics ---');
    Object.entries(all).forEach(([key, value]) => {
      console.log(`${key}: ${value}`);
    });
    console.log('-------------------');
  }
}

// Singleton, matching the plain-export style already used by src/config.ts. Call
// metrics.reset() at the start of a run (ActualAiService.classify) and in test
// beforeEach blocks so counts don't leak across runs/tests.
const metrics = new Metrics();

export default metrics;
