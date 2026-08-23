import { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { CorrelationIdSchema } from '@false-route/contracts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Middleware attaching correlation IDs to request and response headers.
 * Validates caller-provided correlation IDs against the shared 64-character contract.
 */
export function correlationMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerValue = req.headers['x-correlation-id'];
    let correlationId: string;

    if (typeof headerValue === 'string') {
      const parsed = CorrelationIdSchema.safeParse(headerValue.trim());
      correlationId = parsed.success ? parsed.data : `corr-${randomUUID()}`;
    } else {
      correlationId = `corr-${randomUUID()}`;
    }

    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  };
}
