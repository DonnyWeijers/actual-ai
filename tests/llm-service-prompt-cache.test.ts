import { LanguageModel } from 'ai';
import { LlmModelFactoryI } from '../src/types';
import RateLimiter from '../src/utils/rate-limiter';
import { CACHE_BREAKPOINT_MARKER } from '../src/handlebars-helpers';

interface CapturedCall {
  prompt?: string;
  messages?: { role: string; content: unknown }[];
}

async function callWith(
  provider: string,
  promptCacheEnabled: boolean | undefined,
  prompt: string,
): Promise<CapturedCall> {
  const generateTextMock = jest.fn().mockResolvedValue({
    text: '{"type":"existing","categoryId":"abc"}',
  });
  jest.doMock('ai', () => ({ generateText: generateTextMock }));

  const LlmService = (await import('../src/llm-service')).default;

  const llmModelFactory: LlmModelFactoryI = {
    create: () => ({}) as LanguageModel,
    getProvider: () => provider,
    getModelProvider: () => provider,
  };
  const rateLimiter = new RateLimiter();
  rateLimiter.executeWithRateLimiting = async <T>(
    _provider: string,
    op: () => Promise<T>,
  ): Promise<T> => op();

  const svc = new LlmService(llmModelFactory, rateLimiter, true, undefined, { promptCacheEnabled });
  await svc.ask(prompt);

  const firstCall = generateTextMock.mock.calls[0] as [CapturedCall] | undefined;
  if (!firstCall) {
    throw new Error('Expected generateText to be called');
  }
  return firstCall[0];
}

describe('LlmService Anthropic prompt caching', () => {
  const samplePrompt = `INVARIANT_CATEGORIES_AND_RULES${CACHE_BREAKPOINT_MARKER}Now categorize: TRANSACTION_DETAILS`;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default (flag unset): sends a flat prompt with the marker stripped, even for anthropic', async () => {
    const call = await callWith('anthropic', undefined, samplePrompt);

    expect(call.messages).toBeUndefined();
    expect(call.prompt).toBe('INVARIANT_CATEGORIES_AND_RULESNow categorize: TRANSACTION_DETAILS');
    expect(call.prompt).not.toContain(CACHE_BREAKPOINT_MARKER);
  });

  test('flag on, non-anthropic provider: still sends a flat prompt with the marker stripped', async () => {
    const call = await callWith('openai', true, samplePrompt);

    expect(call.messages).toBeUndefined();
    expect(call.prompt).toBe('INVARIANT_CATEGORIES_AND_RULESNow categorize: TRANSACTION_DETAILS');
  });

  test('flag on + anthropic: splits into messages with a cache breakpoint on the invariant prefix', async () => {
    const call = await callWith('anthropic', true, samplePrompt);

    expect(call.prompt).toBeUndefined();
    expect(call.messages).toHaveLength(1);
    const [message] = call.messages!;
    expect(message.role).toBe('user');

    const content = message.content as { type: string; text: string; providerOptions?: unknown }[];
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe('INVARIANT_CATEGORIES_AND_RULES');
    expect(content[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(content[1].text).toBe('Now categorize: TRANSACTION_DETAILS');
    expect(content[1].providerOptions).toBeUndefined();
  });

  test('flag on + anthropic, but a custom template with no {{cacheBreakpoint}}: falls back to a flat prompt, no crash', async () => {
    const call = await callWith('anthropic', true, 'a custom prompt with no marker at all');

    expect(call.messages).toBeUndefined();
    expect(call.prompt).toBe('a custom prompt with no marker at all');
  });
});
