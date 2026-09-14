import PayeeCategoryCache from '../src/transaction/payee-category-cache';
import { UnifiedResponse } from '../src/types';

describe('PayeeCategoryCache', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a fresh key calls the factory and reports fromCache: false', async () => {
    const cache = new PayeeCategoryCache();
    const factory = jest.fn().mockResolvedValue({ type: 'existing', categoryId: 'cat-1' } as UnifiedResponse);

    const result = await cache.getOrCreate('payee-1', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ response: { type: 'existing', categoryId: 'cat-1' }, fromCache: false });
  });

  test('a repeat key reuses the cached response without calling the factory again', async () => {
    const cache = new PayeeCategoryCache();
    const factory = jest.fn().mockResolvedValue({ type: 'existing', categoryId: 'cat-1' } as UnifiedResponse);

    await cache.getOrCreate('payee-1', factory);
    const second = await cache.getOrCreate('payee-1', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
    expect(second.response).toEqual({ type: 'existing', categoryId: 'cat-1' });
  });

  test('different keys never share a response', async () => {
    const cache = new PayeeCategoryCache();
    const factory = jest.fn()
      .mockResolvedValueOnce({ type: 'existing', categoryId: 'cat-1' } as UnifiedResponse)
      .mockResolvedValueOnce({ type: 'existing', categoryId: 'cat-2' } as UnifiedResponse);

    const a = await cache.getOrCreate('payee-1', factory);
    const b = await cache.getOrCreate('payee-2', factory);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(a.response).toEqual({ type: 'existing', categoryId: 'cat-1' });
    expect(b.response).toEqual({ type: 'existing', categoryId: 'cat-2' });
  });

  test('concurrent calls for the same key share one in-flight factory call', async () => {
    const cache = new PayeeCategoryCache();
    let resolveFactory!: (value: UnifiedResponse) => void;
    const factory = jest.fn().mockReturnValue(new Promise<UnifiedResponse>((resolve) => {
      resolveFactory = resolve;
    }));

    const first = cache.getOrCreate('payee-1', factory);
    const second = cache.getOrCreate('payee-1', factory);
    resolveFactory({ type: 'existing', categoryId: 'cat-1' });

    const [a, b] = await Promise.all([first, second]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.response).toEqual(b.response);
  });

  test('a rejection is not cached — the next call for the same key gets a fresh attempt', async () => {
    const cache = new PayeeCategoryCache();
    const factory = jest.fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce({ type: 'existing', categoryId: 'cat-1' } as UnifiedResponse);

    await expect(cache.getOrCreate('payee-1', factory)).rejects.toThrow('transient failure');
    const second = await cache.getOrCreate('payee-1', factory);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.fromCache).toBe(false);
    expect(second.response).toEqual({ type: 'existing', categoryId: 'cat-1' });
  });

  test('an undefined/null/empty key always calls the factory and is never cached', async () => {
    const cache = new PayeeCategoryCache();
    const factory = jest.fn().mockResolvedValue({ type: 'existing', categoryId: 'cat-1' } as UnifiedResponse);

    await cache.getOrCreate(undefined, factory);
    await cache.getOrCreate(null, factory);
    await cache.getOrCreate('', factory);

    expect(factory).toHaveBeenCalledTimes(3);
  });
});
