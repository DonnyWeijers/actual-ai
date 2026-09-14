import RateLimiter from '../../src/utils/rate-limiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    rateLimiter = new RateLimiter();
    jest.useFakeTimers();
    // Mock the sleep function to resolve immediately
    jest.spyOn(rateLimiter as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockImplementation(() => Promise.resolve());
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    consoleSpy.mockRestore();
  });

  describe('setProviderLimit', () => {
    it('should set the provider limit', async () => {
      rateLimiter.setProviderLimit('test-provider', 10);

      // Create a test function that will be rate limited
      const operation = jest.fn().mockResolvedValue('success');

      // Execute the operation multiple times
      for (let i = 0; i < 9; i++) {
        await rateLimiter.executeWithRateLimiting('test-provider', operation);
      }

      // Verify the operation was called the expected number of times
      expect(operation).toHaveBeenCalledTimes(9);
    });

    it('does not wait until the sliding window is actually full', async () => {
      rateLimiter.setProviderLimit('test-provider', 5);
      const operation = jest.fn().mockResolvedValue('success');

      for (let i = 0; i < 5; i++) {
        await rateLimiter.executeWithRateLimiting('test-provider', operation);
      }

      expect(operation).toHaveBeenCalledTimes(5);
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });

    it('waits once the sliding window is full', async () => {
      rateLimiter.setProviderLimit('test-provider', 5);
      const operation = jest.fn().mockResolvedValue('success');

      for (let i = 0; i < 5; i++) {
        await rateLimiter.executeWithRateLimiting('test-provider', operation);
      }
      await rateLimiter.executeWithRateLimiting('test-provider', operation);

      expect(operation).toHaveBeenCalledTimes(6);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });
  });

  describe('executeWithRateLimiting', () => {
    it('should execute the operation successfully', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await rateLimiter.executeWithRateLimiting('test-provider', operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on rate limit errors with status code 429', async () => {
      const rateLimitError = new Error('rate limit exceeded');
      Object.assign(rateLimitError, { statusCode: 429 });

      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      const result = await rateLimiter.executeWithRateLimiting('test-provider', operation, {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: false,
      });

      jest.advanceTimersByTime(100);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit for test-provider'));
    });

    it('should retry on rate limit errors with rate limit message', async () => {
      const rateLimitError = new Error('too many requests, please try again later');

      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      const result = await rateLimiter.executeWithRateLimiting('test-provider', operation, {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: false,
      });

      jest.advanceTimersByTime(100);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const rateLimitError = new Error('rate limit exceeded');
      Object.assign(rateLimitError, { statusCode: 429 });

      const operation = jest.fn().mockRejectedValue(rateLimitError);

      await expect(rateLimiter.executeWithRateLimiting('test-provider', operation, {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: false,
      })).rejects.toThrow('Rate limit retries exceeded');

      jest.advanceTimersByTime(100); // First retry
      jest.advanceTimersByTime(200); // Second retry (exponential backoff)

      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should extract retry time from error message', async () => {
      const rateLimitError = new Error('Rate limit exceeded. Please try again in 2m14s');
      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      const result = await rateLimiter.executeWithRateLimiting('test-provider', operation);
      expect(result).toBe('success');

      // Should mention waiting with a time close to the parsed value (2m14s = 134000ms)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit for test-provider. Waiting 134000ms'));
    });

    it('should extract retry time from headers', async () => {
      const rateLimitError = new Error('rate limit exceeded');
      Object.assign(rateLimitError, {
        statusCode: 429,
        responseHeaders: {
          'retry-after': '10',
        },
      });

      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      const result = await rateLimiter.executeWithRateLimiting('test-provider', operation);
      expect(result).toBe('success');

      // Should mention waiting 10 seconds (10000ms)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit for test-provider. Waiting 10000ms'));
    });

    it('should handle non-rate limit errors', async () => {
      const regularError = new Error('regular error');
      const operation = jest.fn().mockRejectedValue(regularError);

      await expect(rateLimiter.executeWithRateLimiting('test-provider', operation))
        .rejects.toThrow('regular error');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should apply exponential backoff with jitter', async () => {
      // Mock Math.random to return a consistent value for testability
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const rateLimitError = new Error('rate limit exceeded');
      Object.assign(rateLimitError, { statusCode: 429 });

      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      await rateLimiter.executeWithRateLimiting('test-provider', operation, {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        jitter: true,
      });

      // First retry should have baseDelay with jitter: 1000ms * 0.75 = 750ms
      // Second retry should have exponential backoff: 2000ms * 0.75 = 1500ms
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting 750ms'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting 1500ms'));

      randomSpy.mockRestore();
    });
  });

  describe('token bucket handling', () => {
    it('should update token bucket from Groq error message', async () => {
      const groqError = new Error('Limit 100000, Used 99336, Requested 821. Please try again in 30s');
      Object.assign(groqError, { statusCode: 429 });

      const operation = jest.fn()
        .mockRejectedValueOnce(groqError)
        .mockResolvedValueOnce('success');

      rateLimiter.enableDebug();

      const result = await rateLimiter.executeWithRateLimiting('groq', operation);
      expect(result).toBe('success');

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit details for groq:'),
        expect.objectContaining({
          tokenBucket: expect.objectContaining({
            limit: 100000,
            remaining: 664,
          }) as unknown as {
            limit: number;
            remaining: number;
            resetTimestamp?: number;
          },
        }),
      );
    });

    it('should wait for token bucket reset when close to limit', async () => {
      const groqError = new Error('Limit 100, Used 95, Requested 5. Please try again in 30s');
      Object.assign(groqError, { statusCode: 429 });

      const operation1 = jest.fn()
        .mockRejectedValueOnce(groqError)
        .mockResolvedValueOnce('success');

      await rateLimiter.executeWithRateLimiting('groq', operation1);

      // Now try a second operation that should trigger waiting due to low token bucket
      const operation2 = jest.fn().mockResolvedValue('second-success');
      await rateLimiter.executeWithRateLimiting('groq', operation2);

      // Should have logged waiting for token bucket
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting') && expect.stringContaining('for token bucket to reset for groq'));
    });
  });

  describe('tokens-per-minute throttling', () => {
    it('does not throttle when no token limit is configured', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, {
        estimatedTokens: 999_999,
      });
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });

    it('throttles once the estimated tokens for this call would exceed the per-minute budget', async () => {
      rateLimiter.setProviderTokenLimit('test-provider', 1000);
      const operation = jest.fn().mockResolvedValue('success');

      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, { estimatedTokens: 600 });
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));

      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, { estimatedTokens: 600 });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });

    it('a single request exceeding the whole budget is let through rather than waited on forever', async () => {
      rateLimiter.setProviderTokenLimit('test-provider', 100);
      const operation = jest.fn().mockResolvedValue('success');

      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, { estimatedTokens: 5000 });
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('recordActualTokenUsage reconciles the estimate so the window reflects real usage', async () => {
      rateLimiter.setProviderTokenLimit('test-provider', 1000);
      const operation = jest.fn().mockResolvedValue('success');

      // Estimate 600, but the real usage turns out to be tiny — reconciling should
      // free up budget for the next call that a stale 600-token estimate would not.
      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, { estimatedTokens: 600 });
      rateLimiter.recordActualTokenUsage('test-provider', 10);

      await rateLimiter.executeWithRateLimiting('test-provider', operation, undefined, { estimatedTokens: 600 });
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });
  });

  describe('concurrent callers', () => {
    it('proactively throttles once concurrent calls fill the request window, and every call still completes', async () => {
      rateLimiter.setProviderLimit('test-provider', 3);
      const operation = jest.fn().mockResolvedValue('success');

      await Promise.all(
        Array.from({ length: 5 }, () => rateLimiter.executeWithRateLimiting('test-provider', operation)),
      );

      expect(operation).toHaveBeenCalledTimes(5);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Preemptively waiting'));
    });
  });

  describe('debug mode', () => {
    it('should enable debug mode through constructor', () => {
      const debugRateLimiter = new RateLimiter(true);
      expect(debugRateLimiter).toBeDefined();
    });

    it('should enable debug mode through method call', () => {
      rateLimiter.enableDebug();

      // Create a rate limit error to trigger debug logging
      const rateLimitError = new Error('rate limit exceeded');
      Object.assign(rateLimitError, { statusCode: 429 });

      const operation = jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success');

      return rateLimiter.executeWithRateLimiting('test-provider', operation)
        .then(() => {
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Rate limit details for test-provider:'),
            expect.any(Object),
          );
        });
    });
  });
});
