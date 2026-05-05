/**
 * Token bucket rate limiter. We keep one bucket per (scope, operation) pair so the same
 * client can independently respect per-namespace upsert QPS and per-index fetch QPS.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    public readonly capacity: number,
    public readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefillMs = now;
  }

  /** Waits until at least one token is available, then consumes one. */
  async acquire(count = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const deficit = count - this.tokens;
      const refill = Math.max(this.refillPerSecond, 1e-6);
      const waitMs = Math.max(5, Math.ceil((deficit / refill) * 1000));
      await delay(waitMs);
    }
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaults: { capacity: number; refillPerSecond: number },
  ) {}

  private bucketFor(key: string, capacity?: number, refillPerSecond?: number): TokenBucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(
        capacity ?? this.defaults.capacity,
        refillPerSecond ?? this.defaults.refillPerSecond,
      );
      this.buckets.set(key, b);
    }
    return b;
  }

  configure(key: string, capacity: number, refillPerSecond: number): void {
    this.buckets.set(key, new TokenBucket(capacity, refillPerSecond));
  }

  async acquire(key: string, count = 1): Promise<void> {
    await this.bucketFor(key).acquire(count);
  }
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Maximum retry attempts (excluding the initial try). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Predicate for whether an error should trigger a retry. */
  shouldRetry?: (err: unknown) => boolean;
}

const isRetryable = (err: unknown): boolean => {
  if (!err) return false;
  const e = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
    code?: string;
    name?: string;
    message?: string;
  };
  const status = e.status ?? e.statusCode ?? e.response?.status ?? e.response?.statusCode;
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'EAI_AGAIN') return true;
  // Pinecone SDK wraps transient 5xx/network errors as PineconeUnmappedHttpError; retry those
  // unless the message clearly indicates a *client* problem (URI-too-long, dimension mismatch,
  // unauthorized, etc.) where retrying would just burn the retry budget.
  if (e.name === 'PineconeUnmappedHttpError') {
    const msg = e.message ?? '';
    if (/uri too long|414|payload too large|413|400|unauthorized|forbidden|not found/i.test(msg)) {
      return false;
    }
    return true;
  }
  if (typeof e.message === 'string' && /timeout|reset|429|rate limit/i.test(e.message)) return true;
  return false;
};

/**
 * Retry an async operation with full-jitter exponential backoff. Honors `Retry-After` if the
 * thrown error includes one (Pinecone surfaces 429s with backoff hints in some cases).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? isRetryable;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const sleep = Math.floor(Math.random() * exp);
      const retryAfter = (err as { retryAfterMs?: number; retryAfter?: number }).retryAfterMs;
      await delay(retryAfter ?? sleep);
      attempt += 1;
    }
  }
}
