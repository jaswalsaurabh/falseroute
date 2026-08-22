import { type Request, type Response, type NextFunction } from 'express';
import { type ApiErrorResponse } from '@false-route/contracts';
import { MAX_IN_FLIGHT_REQUESTS, OVERLOAD_RETRY_AFTER_SECONDS } from '../config/rate-limits.js';

export interface OverloadGuardOptions {
  /** Injectable ceiling for deterministic tests. */
  readonly maxInFlight?: number;
}

/**
 * Deployment-overload boundary: when the number of in-flight requests reaches
 * the process ceiling, subsequent requests are shed with 503 SERVICE_OVERLOAD.
 *
 * This is distinct from a client quota rejection (429 TOO_MANY_REQUESTS): it
 * does not imply any particular principal exceeded its allowance.
 */
export function createOverloadGuard(options: OverloadGuardOptions = {}) {
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT_REQUESTS;
  let inFlight = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (inFlight >= maxInFlight) {
      const errorResponse: ApiErrorResponse = {
        error: 'SERVICE_OVERLOAD',
        message: 'The service is currently at capacity; retry shortly',
        correlationId: req.correlationId,
      };
      res.setHeader('Retry-After', String(OVERLOAD_RETRY_AFTER_SECONDS));
      res.status(503).json(errorResponse);
      return;
    }

    inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}
