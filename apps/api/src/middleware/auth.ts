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
import {
  OPERATOR_CSRF_COOKIE,
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
  operatorCsrfTokensMatch,
  readCookie,
  sessionCookieHeaders,
  verifyOperatorCsrfToken,
  verifyOperatorSession,
} from './operator-session.js';

export interface AuthMiddlewareOptions {
  readonly expectedToken: string;
  readonly sessionSecret?: string | undefined;
  readonly secureCookies?: boolean | undefined;
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
    const sessionCookie = readCookie(req.headers.cookie, OPERATOR_SESSION_COOKIE);
    const authenticatedByBearer = verifyOperatorToken(bearerToken, options.expectedToken);
    const authenticatedBySession = options.sessionSecret
      ? verifyOperatorSession(sessionCookie, options.sessionSecret, options.clock?.() ?? Date.now())
      : false;

    if ((!authenticatedByBearer || bearerToken === null) && !authenticatedBySession) {
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

    if (
      authenticatedBySession &&
      !authenticatedByBearer &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    ) {
      const csrfCookie = readCookie(req.headers.cookie, OPERATOR_CSRF_COOKIE);
      const csrfHeader = req.header('X-CSRF-Token');
      if (
        !operatorCsrfTokensMatch(csrfCookie, csrfHeader) ||
        !verifyOperatorCsrfToken(
          sessionCookie,
          csrfHeader,
          options.sessionSecret!,
          options.clock?.() ?? Date.now(),
        )
      ) {
        res.status(403).json({
          error: 'CSRF_REQUIRED',
          message: 'A valid CSRF token is required for cookie-authenticated requests',
          correlationId: req.correlationId,
        });
        return;
      }
    }

    // Verified non-secret principal fingerprint used as the rate-limit identity base.
    // The raw bearer token is never stored, logged, or used as a limiter key.
    if (!req.principalId && bearerToken) {
      req.principalId = computeCredentialFingerprint(bearerToken, 'operator');
    } else if (!req.principalId && authenticatedBySession) {
      req.principalId = 'operator:session';
    }
    if (authenticatedByBearer && !authenticatedBySession && options.sessionSecret) {
      const session = createOperatorSession(options.sessionSecret, options.clock?.() ?? Date.now());
      for (const cookie of sessionCookieHeaders(session, options.secureCookies ?? false)) {
        res.append('Set-Cookie', cookie);
      }
    }
    next();
  };
}
