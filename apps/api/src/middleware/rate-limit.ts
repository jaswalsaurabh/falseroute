import { type Request, type Response, type NextFunction } from 'express';
import { type ApiErrorResponse } from '@false-route/contracts';
import {
  type RequestClassBudget,
  type RequestClassName,
  getRequestClassBudget,
} from '../config/rate-limits.js';
import { formatLimiterKey, resolveLimiterIdentity } from './principal.js';

interface WindowRecord {
  count: number;
  resetAt: number;
}

export interface FixedWindowCounterOptions {
  readonly budget: Readonly<RequestClassBudget>;
  readonly clock?: () => number;
}

export interface ConsumeResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/**
 * Process-local fixed-window counter. A fresh window resets the full allowance.
 * Enforces budgets only within the current process; never cross-instance.
 */
export class FixedWindowCounter {
  private readonly records = new Map<string, WindowRecord>();
  private readonly now: () => number;

  constructor(private readonly options: FixedWindowCounterOptions) {
    this.now = options.clock ?? Date.now;
  }

  consume(key: string): ConsumeResult {
    const currentTime = this.now();
    const record = this.records.get(key);
    if (!record || currentTime >= record.resetAt) {
      this.records.set(key, {
        count: 1,
        resetAt: currentTime + this.options.budget.windowMs,
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (record.count >= this.options.budget.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: record.resetAt - currentTime,
      };
    }

    record.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

export interface RateLimiterOptions {
  readonly className: RequestClassName;
  /**
   * Injectable monotonic clock (milliseconds) for deterministic window tests.
   */
  readonly clock?: () => number;
}

/**
 * Process-local fixed-window request budget keyed by verified principal or
 * trusted-proxy-aware source IP.
 *
 * This limiter is explicitly process-local: it enforces budgets only for the
 * current process and does not coordinate across instances.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const counter = new FixedWindowCounter({
    budget: getRequestClassBudget(options.className),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = formatLimiterKey(resolveLimiterIdentity(req));
    const result = counter.consume(key);

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      const errorResponse: ApiErrorResponse = {
        error: 'TOO_MANY_REQUESTS',
        message: `Request budget exceeded for ${options.className} operations; retry after the window resets`,
        correlationId: req.correlationId,
      };
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json(errorResponse);
      return;
    }

    next();
  };
}
