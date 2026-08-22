import { type Request, type Response, type NextFunction } from 'express';
import { type ApiErrorResponse } from '@false-route/contracts';
import {
  getRequestClassBudget,
  type RequestClassBudget,
  type RequestClassName,
} from '../config/rate-limits.js';
import { formatLimiterKey, resolveLimiterIdentity } from './principal.js';

export interface BucketRecord {
  tokens: number;
  lastRefillMs: number;
  lastAccessMs: number;
}

export interface TokenBucketOptions {
  readonly budget: Readonly<RequestClassBudget>;
  readonly maxKeys?: number | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface ConsumeResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly remainingTokens: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Process-local Token Bucket Rate Limiter.
 * Supports burst capacity with smooth monotonic token refill.
 * Uses bounded O(1) LRU memory storage with automatic eviction to remain safe under rotating attacker IPs.
 *
 * NOTE: This is explicitly process-local: it enforces budgets only for the
 * current process and does not coordinate across instances.
 */
export class TokenBucketCounter {
  private readonly records = new Map<string, BucketRecord>();
  private readonly budget: Readonly<RequestClassBudget>;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.budget = options.budget;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.now = options.clock ?? Date.now;
  }

  get size(): number {
    return this.records.size;
  }

  getRecord(key: string): BucketRecord | undefined {
    return this.records.get(key);
  }

  /**
   * Removes idle entries whose tokens are completely refilled and have not been accessed
   * for more than idleMs (default: twice the windowMs).
   */
  pruneExpired(idleMs = this.budget.windowMs * 2): number {
    const currentTime = this.now();
    const refillRatePerMs = this.budget.refillRatePerSecond / 1000;
    const capacity = this.budget.burstCapacity;
    let pruned = 0;
    for (const [key, record] of this.records.entries()) {
      const elapsedMs = Math.max(0, currentTime - record.lastRefillMs);
      const currentTokens = Math.min(capacity, record.tokens + elapsedMs * refillRatePerMs);
      if (currentTokens >= capacity && currentTime - record.lastAccessMs > idleMs) {
        this.records.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  consume(key: string, tokensToConsume = 1): ConsumeResult {
    const currentTime = this.now();
    const refillRatePerMs = this.budget.refillRatePerSecond / 1000;
    const capacity = this.budget.burstCapacity;

    let record = this.records.get(key);

    if (!record) {
      // Ensure capacity ceiling is maintained before inserting new keys via O(1) LRU eviction.
      // Does not perform O(N) scan on request hot path.
      if (this.records.size >= this.maxKeys) {
        const oldestKey = this.records.keys().next().value;
        if (oldestKey !== undefined) {
          this.records.delete(oldestKey);
        }
      }

      if (capacity >= tokensToConsume) {
        const remaining = capacity - tokensToConsume;
        this.records.set(key, {
          tokens: remaining,
          lastRefillMs: currentTime,
          lastAccessMs: currentTime,
        });
        return { allowed: true, retryAfterMs: 0, remainingTokens: remaining };
      }

      const deficit = tokensToConsume - capacity;
      const retryAfterMs = Math.ceil(deficit / refillRatePerMs);
      return { allowed: false, retryAfterMs, remainingTokens: 0 };
    }

    // Move to end of Map for LRU freshness
    this.records.delete(key);

    // Calculate monotonic token refill
    const elapsedMs = Math.max(0, currentTime - record.lastRefillMs);
    const refilledTokens = record.tokens + elapsedMs * refillRatePerMs;
    const currentTokens = Math.min(capacity, refilledTokens);

    if (currentTokens >= tokensToConsume) {
      const remaining = currentTokens - tokensToConsume;
      record = {
        tokens: remaining,
        lastRefillMs: currentTime,
        lastAccessMs: currentTime,
      };
      this.records.set(key, record);
      return { allowed: true, retryAfterMs: 0, remainingTokens: remaining };
    }

    const deficit = tokensToConsume - currentTokens;
    const retryAfterMs = Math.ceil(deficit / refillRatePerMs);

    record = {
      tokens: currentTokens,
      lastRefillMs: currentTime,
      lastAccessMs: currentTime,
    };
    this.records.set(key, record);

    return { allowed: false, retryAfterMs, remainingTokens: currentTokens };
  }
}

export interface RateLimiterOptions {
  readonly className: RequestClassName;
  readonly keyMode?: 'principal' | 'ip' | 'composite' | undefined;
  readonly secondaryKeyMode?: 'ip' | undefined;
  /**
   * Injectable monotonic clock (milliseconds) for deterministic window tests.
   */
  readonly clock?: (() => number) | undefined;
  readonly maxKeys?: number | undefined;
  readonly customBudget?: RequestClassBudget | undefined;
}

/**
 * Creates an Express rate-limiting middleware enforcing process-local request budgets.
 * Returns 429 Too Many Requests with Retry-After header and bounded JSON payload upon exhaustion.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const budget = options.customBudget ?? getRequestClassBudget(options.className);
  const counter = new TokenBucketCounter({
    budget,
    maxKeys: options.maxKeys,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  const secondaryCounter =
    options.secondaryKeyMode === undefined
      ? undefined
      : new TokenBucketCounter({
          budget,
          maxKeys: options.maxKeys,
          ...(options.clock !== undefined ? { clock: options.clock } : {}),
        });

  const reject = (req: Request, res: Response, result: ConsumeResult): void => {
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    const errorResponse: ApiErrorResponse = {
      error: 'TOO_MANY_REQUESTS',
      message: `Request budget exceeded for ${options.className} operations; retry after ${retryAfterSeconds}s`,
      correlationId: req.correlationId,
    };
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json(errorResponse);
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveLimiterIdentity(req);
    const key = formatLimiterKey(identity, options.keyMode);
    const result = counter.consume(key);

    if (!result.allowed) {
      reject(req, res, result);
      return;
    }

    if (secondaryCounter !== undefined) {
      const secondaryKey = formatLimiterKey(identity, options.secondaryKeyMode);
      if (secondaryKey !== key) {
        const secondaryResult = secondaryCounter.consume(secondaryKey);
        if (!secondaryResult.allowed) {
          reject(req, res, secondaryResult);
          return;
        }
      }
    }

    next();
  };

  middleware.counter = counter;
  middleware.secondaryCounter = secondaryCounter;
  return middleware;
}
