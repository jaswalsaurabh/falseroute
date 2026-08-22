import { type Request, type Response, type NextFunction } from 'express';
import { type ApiErrorResponse } from '@false-route/contracts';

interface ClientRecord {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  readonly windowMs?: number;
  readonly maxRequests?: number;
}

/**
 * Lightweight in-memory rate limiter per client IP.
 * Used for controlling brute force / flooding on demo endpoints.
 */
export function rateLimitMiddleware(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60000;
  const maxRequests = options.maxRequests ?? 100;
  const records = new Map<string, ClientRecord>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    const record = records.get(ip);
    if (!record || now > record.resetAt) {
      records.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (record.count >= maxRequests) {
      const errorResponse: ApiErrorResponse = {
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded; please retry later',
        correlationId: req.correlationId,
      };
      res.status(429).json(errorResponse);
      return;
    }

    record.count += 1;
    next();
  };
}
