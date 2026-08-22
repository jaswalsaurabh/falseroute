import { type Request, type Response, type NextFunction } from 'express';
import { verifyOperatorToken, extractBearerToken } from '@false-route/security';
import { type ApiErrorResponse } from '@false-route/contracts';
import { getRequestClassBudget } from '../config/rate-limits.js';
import { TokenBucketCounter } from './rate-limit.js';
import {
  computeCredentialFingerprint,
  formatLimiterKey,
  resolveLimiterIdentity,
} from './principal.js';

export interface AuthMiddlewareOptions {
  readonly expectedToken: string;
  readonly clock?: (() => number) | undefined;
}

/**
 * Operator authentication middleware.
 * Verifies Bearer token against the configured operator secret using constant-time
 * comparison. Bounds repeated failed verification attempts per source address
 * with the 'abuse' request-class budget; failed attempts never reach controllers.
 */
export function operatorAuthMiddleware(options: AuthMiddlewareOptions) {
  const failureBudget = new TokenBucketCounter({
    budget: getRequestClassBudget('abuse'),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(req.headers.authorization);

    if (!verifyOperatorToken(bearerToken, options.expectedToken) || bearerToken === null) {
      const key = formatLimiterKey(resolveLimiterIdentity(req), 'ip');
      const attempt = failureBudget.consume(key);

      if (!attempt.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(attempt.retryAfterMs / 1000));
        const errorResponse: ApiErrorResponse = {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many failed authentication attempts; retry after the window resets',
          correlationId: req.correlationId,
        };
        res.setHeader('Retry-After', String(retryAfterSeconds));
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

    // Verified non-secret principal fingerprint used as the rate-limit identity base.
    // The raw bearer token is never stored, logged, or used as a limiter key.
    if (!req.principalId) {
      req.principalId = computeCredentialFingerprint(bearerToken, 'operator');
    }
    next();
  };
}
