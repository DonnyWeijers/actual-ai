import mapWithConcurrency from '../src/utils/concurrency';

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  test('never runs more than `limit` calls at once, and reaches the limit when there is enough work', async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      active -= 1;
      return item * 2;
    });

    expect(peak).toBe(3);
  });

  test('preserves input order in the results regardless of completion order', async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await new Promise((resolve) => { setTimeout(resolve, delay); });
      return index;
    });

    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : undefined))).toEqual([0, 1, 2, 3]);
  });

  test('one rejection does not stop the others, and is reported per-item', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, (item) => {
      if (item === 2) {
        return Promise.reject(new Error('item 2 failed'));
      }
      return Promise.resolve(item * 10);
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toEqual(new Error('item 2 failed'));
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  test('a slow item does not stall workers from picking up later items', async () => {
    const slow = defer<void>();
    const completionOrder: number[] = [];

    const run = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      if (item === 0) {
        await slow.promise;
      }
      completionOrder.push(item);
      return item;
    });

    // Let the fast items (1, 2, 3) run to completion while item 0 is still pending.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(completionOrder).toEqual([1, 2, 3]);

    slow.resolve();
    await run;
    expect(completionOrder).toEqual([1, 2, 3, 0]);
  });

  test('an empty input returns an empty result with no calls', async () => {
    const fn = jest.fn();
    const results = await mapWithConcurrency([], 5, fn);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test('limit larger than the item count still runs every item exactly once', async () => {
    const fn = jest.fn().mockImplementation((item: number) => Promise.resolve(item));
    const results = await mapWithConcurrency([1, 2], 10, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : undefined))).toEqual([1, 2]);
  });
});
