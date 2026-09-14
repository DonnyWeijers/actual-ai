// Define a custom error type for API rate limiting errors
interface RateLimitError extends Error {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
}

interface RetryParams {
  retryAfterMs?: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

interface TokenBucket {
  limit: number;
  remaining: number;
  resetTimestamp: number;
}

interface TokenUsageEntry {
  time: number;
  tokens: number;
}

interface ExecuteOptions {
  /** Estimated outgoing prompt tokens for this call (e.g. chars/4). Only needed if a
   * tokens-per-minute limit is set for this provider; omit otherwise. */
  estimatedTokens?: number;
}

const WINDOW_MS = 60_000;

class RateLimiter {
  // Sliding windows: every entry is a real timestamp, pruned to the trailing 60s on
  // each check. Replaces the old requestCounts/lastRequestTime pair, whose "reset if
  // more than a minute since the LAST request" logic meant the window's effective
  // start kept sliding forward on every single call — at 80% of the limit it could
  // wait close to a full 60s measured from the most recent call, not from when the
  // window actually opened.
  private requestTimestamps = new Map<string, number[]>();

  private tokenUsageWindow = new Map<string, TokenUsageEntry[]>();

  // Best-effort pointer to the most recently registered token-usage estimate for a
  // provider, so a caller can reconcile it against real SDK usage once known (see
  // recordActualTokenUsage). Under concurrency this may not be the exact entry a
  // given call registered if several overlap — acceptable: this only feeds a
  // proactive sliding-window estimate, not a billing record, and staying close to
  // real usage over time is what matters, not perfect per-call attribution.
  private lastTokenEntry = new Map<string, TokenUsageEntry>();

  private maxRequestsPerMinute = new Map<string, number>();

  private maxTokensPerMinute = new Map<string, number>();

  private tokenBuckets = new Map<string, TokenBucket>();

  private debugMode = false;

  constructor(debug = false) {
    this.debugMode = debug;
  }

  public setProviderLimit(provider: string, limit: number): void {
    this.maxRequestsPerMinute.set(provider, limit);
  }

  /** 0 or unset both mean "no token-based throttling for this provider" — same
   * unset/0/positive trichotomy as setProviderLimit, resolved by the caller
   * (LlmService) before this is ever called. */
  public setProviderTokenLimit(provider: string, limit: number): void {
    this.maxTokensPerMinute.set(provider, limit);
  }

  public enableDebug(): void {
    this.debugMode = true;
  }

  /** Call once the real SDK response is in, if it reports usage — replaces this
   * call's chars/4 estimate with the real token count so the sliding window stays
   * accurate over time instead of drifting from a rough estimate. Safe to skip: if
   * there's nothing to reconcile (no token limit configured, or the entry already
   * aged out of the window), this is a no-op. */
  public recordActualTokenUsage(provider: string, actualTokens: number): void {
    const entry = this.lastTokenEntry.get(provider);
    if (entry) {
      entry.tokens = actualTokens;
    }
  }

  public async executeWithRateLimiting<T>(
    provider: string,
    operation: () => Promise<T>,
    retryParams: RetryParams = {
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      jitter: true,
    },
    options: ExecuteOptions = {},
  ): Promise<T> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= retryParams.maxRetries) {
      try {
        if (attempt > 0) {
          console.log(`Retry attempt ${attempt}/${retryParams.maxRetries} for ${provider}...`);
        }

        await this.reserveCapacity(provider, options.estimatedTokens ?? 0);

        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (this.isRateLimitError(error)) {
          this.updateTokenBucketFromError(provider, error);

          // Get retry delay from error or calculate backoff
          const retryAfterMs = this.extractRetryAfterMs(error) ?? this.calculateBackoff(
            attempt,
            retryParams.baseDelayMs,
            retryParams.maxDelayMs,
            retryParams.jitter,
          );

          // Add additional details in debug mode
          if (this.debugMode) {
            console.log(`Rate limit details for ${provider}:`, this.getRateLimitDebugInfo(provider, error));
          }

          console.log(`Rate limit hit for ${provider}. Waiting ${retryAfterMs}ms before retry.`);
          await this.sleep(retryAfterMs);
          attempt += 1;
        } else {
          // Not a rate limit error, rethrow
          throw error;
        }
      }
    }

    // If we've exhausted all retries
    throw new Error(`Rate limit retries exceeded (${retryParams.maxRetries}). Last error: ${lastError?.message}`);
  }

  private getRateLimitDebugInfo(provider: string, error: unknown): object {
    const bucket = this.tokenBuckets.get(provider);
    const errorInfo: { message: string; statusCode?: number; headers?: Record<string, string> } = {
      message: '',
    };

    if (error instanceof Error) {
      errorInfo.message = error.message;
      // Type guard for rate limit errors
      const rateLimitError = error as Partial<RateLimitError>;
      if ('statusCode' in error) errorInfo.statusCode = rateLimitError.statusCode;
      if ('responseHeaders' in error) errorInfo.headers = rateLimitError.responseHeaders;
    }

    return {
      provider,
      errorInfo,
      tokenBucket: bucket ?? 'No token data available',
      requestsInLastMinute: (this.requestTimestamps.get(provider) ?? []).length,
      maxRequestsPerMinute: this.maxRequestsPerMinute.get(provider) ?? 'No limit set',
    };
  }

  private updateTokenBucketFromError(provider: string, error: unknown): void {
    if (!(error instanceof Error)) return;

    try {
      const errorMsg = error.message;

      // Extract Groq token information
      // Example: "Limit 100000, Used 99336, Requested 821"
      const limitMatch = /Limit (\d+), Used (\d+), Requested (\d+)/.exec(errorMsg);
      if (limitMatch) {
        const [, limitStr, usedStr] = limitMatch;
        const limit = parseInt(limitStr, 10);
        const used = parseInt(usedStr, 10);

        // Extract wait time: "Please try again in 2m14.975999999s"
        const waitTimeMatch = /try again in ((\d+)m)?(\d+(\.\d+)?)s/i.exec(errorMsg);
        let waitTimeMs = 0;

        if (waitTimeMatch) {
          const minutes = waitTimeMatch[2] ? parseInt(waitTimeMatch[2], 10) : 0;
          const seconds = parseFloat(waitTimeMatch[3]);
          waitTimeMs = (minutes * 60 + seconds) * 1000;
        }

        const now = Date.now();
        this.tokenBuckets.set(provider, {
          limit,
          remaining: Math.max(0, limit - used),
          resetTimestamp: now + waitTimeMs,
        });

        if (this.debugMode) {
          console.log(`Updated token bucket for ${provider}:`, this.tokenBuckets.get(provider));
        }
      }
    } catch (e) {
      console.warn('Error updating token bucket from error:', e);
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      // Check for common rate limit status codes and messages
      const rateLimitError = error as Partial<RateLimitError>;
      if ('statusCode' in error && rateLimitError.statusCode === 429) {
        return true;
      }

      // Check for rate limit messages
      const errorMessage = error.message.toLowerCase();
      return errorMessage.includes('rate limit')
        || errorMessage.includes('too many requests');
    }
    return false;
  }

  private extractRetryAfterMs(error: unknown): number | undefined {
    if (error instanceof Error) {
      try {
        // Try to extract from Groq error message
        const match = /try again in ((\d+)m)?(\d+(\.\d+)?)s/i.exec(error.message);
        if (match) {
          const minutes = match[2] ? parseInt(match[2], 10) : 0;
          const seconds = parseFloat(match[3]);
          return Math.ceil((minutes * 60 + seconds) * 1000);
        }

        // Try to get from headers if available
        const rateLimitError = error as Partial<RateLimitError>;
        if ('responseHeaders' in error && rateLimitError.responseHeaders) {
          const headers = rateLimitError.responseHeaders;
          if (headers && 'retry-after' in headers) {
            const retryAfter = headers['retry-after'];
            if (retryAfter && !Number.isNaN(Number(retryAfter))) {
              return Number(retryAfter) * 1000;
            }
          }
        }
      } catch (e) {
        console.warn('Error extracting retry-after information:', e);
      }
    }
    return undefined;
  }

  private calculateBackoff(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    jitter: boolean,
  ): number {
    // Exponential backoff: baseDelay * 2^attempt
    let delay = Math.min(baseDelay * 2 ** attempt, maxDelay);

    // Add jitter to avoid thundering herd problem
    if (jitter) {
      delay *= (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  private pruneWindow(provider: string, now: number): void {
    const cutoff = now - WINDOW_MS;
    const reqs = this.requestTimestamps.get(provider);
    if (reqs) {
      const kept = reqs.filter((t) => t > cutoff);
      this.requestTimestamps.set(provider, kept);
    }
    const toks = this.tokenUsageWindow.get(provider);
    if (toks) {
      const kept = toks.filter((entry) => entry.time > cutoff);
      this.tokenUsageWindow.set(provider, kept);
    }
  }

  private computeRequestWaitMs(provider: string, now: number): number {
    const limit = this.maxRequestsPerMinute.get(provider);
    if (!limit) {
      return 0;
    }
    const reqs = this.requestTimestamps.get(provider) ?? [];
    if (reqs.length < limit) {
      return 0;
    }
    // Pruned above, so index 0 is the oldest timestamp still inside the window —
    // once IT ages out, there's room again.
    return reqs[0] + WINDOW_MS - now + 100;
  }

  private computeTokenWaitMs(provider: string, now: number, estimatedTokens: number): number {
    const limit = this.maxTokensPerMinute.get(provider);
    if (!limit) {
      return 0;
    }
    const toks = this.tokenUsageWindow.get(provider) ?? [];
    const used = toks.reduce((sum, entry) => sum + entry.tokens, 0);
    if (used + estimatedTokens <= limit || toks.length === 0) {
      // Either there's room, or a single request already exceeds the whole budget —
      // in the latter case there's nothing to usefully wait for, so let it through
      // rather than waiting forever on a window that can never satisfy it alone.
      return 0;
    }
    return toks[0].time + WINDOW_MS - now + 100;
  }

  /**
   * Claims a request slot (and, if a token limit is configured, a token-budget slot)
   * for `provider`. Single-shot, like the pre-Phase-3 code: compute how long to
   * wait, wait once if needed, then register the claim and proceed — no retry loop.
   * A loop that re-checks after sleeping sounds more correct, but it isn't free:
   * under a mocked/frozen clock (real in tests, and possible in practice if a
   * system clock stalls) a sleep that resolves without time actually advancing
   * would spin forever recomputing the same positive wait. One wait, then proceed,
   * can't do that — and in exchange for that safety it can occasionally admit a
   * request into the current second slightly early. That's an acceptable trade for
   * this project's actual use (a single local Ollama instance, low concurrency).
   */
  private async reserveCapacity(provider: string, estimatedTokens: number): Promise<void> {
    const now = Date.now();
    this.pruneWindow(provider, now);

    // Token bucket (reactive, learned from a provider's 429 error body) takes
    // priority over the proactive sliding-window estimate below.
    const bucket = this.tokenBuckets.get(provider);
    if (bucket && bucket.resetTimestamp > now && bucket.remaining < bucket.limit * 0.1) {
      const wait = bucket.resetTimestamp - now + 1000;
      console.log(`Waiting ${wait}ms for token bucket to reset for ${provider}`);
      await this.sleep(wait);
    } else {
      const wait = Math.max(
        this.computeRequestWaitMs(provider, now),
        this.computeTokenWaitMs(provider, now, estimatedTokens),
      );
      if (wait > 0) {
        console.log(`Preemptively waiting ${wait}ms to avoid rate limit for ${provider}`);
        await this.sleep(wait);
      }
    }

    const claimTime = Date.now();
    const reqs = this.requestTimestamps.get(provider) ?? [];
    reqs.push(claimTime);
    this.requestTimestamps.set(provider, reqs);

    if (this.maxTokensPerMinute.get(provider)) {
      const toks = this.tokenUsageWindow.get(provider) ?? [];
      const entry: TokenUsageEntry = { time: claimTime, tokens: estimatedTokens };
      toks.push(entry);
      this.tokenUsageWindow.set(provider, toks);
      this.lastTokenEntry.set(provider, entry);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

export default RateLimiter;
