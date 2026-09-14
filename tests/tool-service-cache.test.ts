type ToolExecute = (
  args: { query: string },
  options: never,
) => PromiseLike<string>;

/**
 * Builds a ToolService whose ValueSerp call is stubbed, so the tests exercise the cache only.
 */
async function setUpWebSearch(): Promise<{ execute: ToolExecute; searchSpy: jest.SpyInstance }> {
  process.env.FEATURES = '["webSearch"]';

  const ToolService = (await import('../src/utils/tool-service')).default;
  const searchSpy = jest.spyOn(
    ToolService.prototype as unknown as { performSearch: (query: string) => Promise<unknown> },
    'performSearch',
  ).mockResolvedValue({ organic_results: [{ title: 'T', snippet: 'S', link: 'L' }] });

  const webSearchTool = new ToolService('value-serp-key').getTools().webSearch;
  if (!webSearchTool?.execute) {
    throw new Error('webSearch tool is unavailable');
  }

  return {
    execute: webSearchTool.execute.bind(webSearchTool) as unknown as ToolExecute,
    searchSpy,
  };
}

describe('ToolService caching', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  test('webSearch results are cached per query', async () => {
    const { execute, searchSpy } = await setUpWebSearch();

    // Call tool twice with identical query; underlying search should execute once.
    await expect(
      execute({ query: 'Example' }, { toolCallId: 't1', messages: [] } as never),
    ).resolves.toContain('[Source 1] T');
    await expect(
      execute({ query: 'Example' }, { toolCallId: 't2', messages: [] } as never),
    ).resolves.toContain('[Source 1] T');
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  test('cache entry expires after TTL', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    const { execute, searchSpy } = await setUpWebSearch();

    await execute({ query: 'Example' }, { toolCallId: 't1', messages: [] } as never);
    nowSpy.mockReturnValue(1_000 + (30 * 60 * 1000) + 1);
    await execute({ query: 'Example' }, { toolCallId: 't2', messages: [] } as never);

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  test('cache evicts oldest entries when size cap is reached', async () => {
    const { execute, searchSpy } = await setUpWebSearch();

    // Fill up 201 unique entries (max is 200), forcing oldest eviction.
    await Array.from({ length: 201 }, (_, i) => i).reduce(async (prev, i) => {
      await prev;
      await execute({ query: `Example ${i}` }, { toolCallId: `t${i}`, messages: [] } as never);
    }, Promise.resolve());
    await execute({ query: 'Example 0' }, { toolCallId: 't-final', messages: [] } as never);

    expect(searchSpy).toHaveBeenCalledTimes(202);
  });

  test('concurrent lookups of the same query share one in-flight request', async () => {
    const { execute, searchSpy } = await setUpWebSearch();

    const results = await Promise.all([
      execute({ query: 'Example' }, { toolCallId: 't1', messages: [] } as never),
      execute({ query: 'Example' }, { toolCallId: 't2', messages: [] } as never),
      execute({ query: 'Example' }, { toolCallId: 't3', messages: [] } as never),
    ]);

    expect(searchSpy).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r).toContain('[Source 1] T'));
  });

  test('a rejected search is evicted rather than cached — the next lookup retries', async () => {
    process.env.FEATURES = '["webSearch"]';
    const ToolService = (await import('../src/utils/tool-service')).default;
    const searchSpy = jest.spyOn(
      ToolService.prototype as unknown as { performSearch: (query: string) => Promise<unknown> },
      'performSearch',
    )
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ organic_results: [{ title: 'T', snippet: 'S', link: 'L' }] });

    const webSearchTool = new ToolService('value-serp-key').getTools().webSearch;
    if (!webSearchTool?.execute) {
      throw new Error('webSearch tool is unavailable');
    }
    const execute = webSearchTool.execute.bind(webSearchTool) as unknown as ToolExecute;

    await expect(execute({ query: 'Example' }, { toolCallId: 't1', messages: [] } as never))
      .rejects.toThrow('network error');
    await expect(execute({ query: 'Example' }, { toolCallId: 't2', messages: [] } as never))
      .resolves.toContain('[Source 1] T');

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });
});
