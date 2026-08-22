import { type Request, type Response, type NextFunction } from 'express';
import { verifyOperatorToken, extractBearerToken } from '@false-route/security';
import { type ApiErrorResponse } from '@false-route/contracts';
import { getRequestClassBudget } from '../config/rate-limits.js';
import { FixedWindowCounter } from './rate-limit.js';
import { formatLimiterKey, resolveLimiterIdentity } from './principal.js';

export interface AuthMiddlewareOptions {
  readonly expectedToken: string;
}

/**
 * Operator authentication middleware.
 * Verifies Bearer token against the configured operator secret using constant-time
 * comparison. Bounds repeated failed verification attempts per source address
 * with the 'abuse' request-class budget; failed attempts never reach controllers.
 */
export function operatorAuthMiddleware(options: AuthMiddlewareOptions) {
  const failureBudget = new FixedWindowCounter({
    budget: getRequestClassBudget('abuse'),
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(req.headers.authorization);

    if (!verifyOperatorToken(bearerToken, options.expectedToken)) {
      const key = formatLimiterKey(resolveLimiterIdentity(req));
      const attempt = failureBudget.consume(key);

      if (!attempt.allowed) {
        const errorResponse: ApiErrorResponse = {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many failed authentication attempts; retry after the window resets',
          correlationId: req.correlationId,
        };
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1000))));
        res.status(429).json(errorResponse);
        return;
      }

      const errorResponse: ApiErrorResponse = {
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing operator access token for controlled demonstration',
        correlationId: req.correlationId,
      };

      res.status(401).json(errorResponse);
      return;
    }

    // Verified non-secret principal label used as the rate-limit key base.
    // The bearer token is never stored, logged, or used as a limiter key.
    req.principalId = 'operator';
    next();
  };
}
