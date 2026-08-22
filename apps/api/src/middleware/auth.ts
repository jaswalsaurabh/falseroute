import { type Request, type Response, type NextFunction } from 'express';
import { verifyOperatorToken, extractBearerToken } from '@false-route/security';
import { type ApiErrorResponse } from '@false-route/contracts';

export interface AuthMiddlewareOptions {
  readonly expectedToken: string;
}

/**
 * Controlled-demo authentication middleware.
 * Verifies Bearer token against the configured operator secret using constant-time comparison.
 */
export function operatorAuthMiddleware(options: AuthMiddlewareOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(req.headers.authorization);

    if (!verifyOperatorToken(bearerToken, options.expectedToken)) {
      const errorResponse: ApiErrorResponse = {
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing operator access token for controlled demonstration',
        correlationId: req.correlationId,
      };

      res.status(401).json(errorResponse);
      return;
    }

    next();
  };
}
