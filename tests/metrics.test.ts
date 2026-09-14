import metrics from '../src/utils/metrics';

describe('metrics', () => {
  beforeEach(() => {
    metrics.reset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('counters start at zero after reset', () => {
    expect(metrics.get('llm_requests')).toBe(0);
    expect(metrics.get('classification_run_ms')).toBe(0);
  });

  test('incr adds to a counter, defaulting to 1', () => {
    metrics.incr('llm_requests');
    metrics.incr('llm_requests');
    metrics.incr('category_suggestions_merged', 5);
    expect(metrics.get('llm_requests')).toBe(2);
    expect(metrics.get('category_suggestions_merged')).toBe(5);
  });

  test('addMs accumulates into a timer', () => {
    metrics.addMs('llm_request_ms_total', 120);
    metrics.addMs('llm_request_ms_total', 80);
    expect(metrics.get('llm_request_ms_total')).toBe(200);
  });

  test('timeAsync records elapsed time and returns the operation result', async () => {
    const result = await metrics.timeAsync('category_creation_ms', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return 'done';
    });
    expect(result).toBe('done');
    expect(metrics.get('category_creation_ms')).toBeGreaterThanOrEqual(5);
  });

  test('timeAsync still records time when the operation throws', async () => {
    await expect(metrics.timeAsync('category_creation_ms', () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(metrics.get('category_creation_ms')).toBeGreaterThanOrEqual(0);
  });

  test('reset clears both counters and timers', () => {
    metrics.incr('llm_requests', 3);
    metrics.addMs('llm_request_ms_total', 500);
    metrics.reset();
    expect(metrics.get('llm_requests')).toBe(0);
    expect(metrics.get('llm_request_ms_total')).toBe(0);
  });

  test('snapshot returns every counter and timer', () => {
    metrics.incr('transactions_processed', 4);
    const snapshot = metrics.snapshot();
    expect(snapshot.transactions_processed).toBe(4);
    expect(snapshot).toHaveProperty('classification_run_ms');
  });
});
