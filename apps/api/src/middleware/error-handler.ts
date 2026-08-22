import { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { type ApiErrorResponse } from '@false-route/contracts';
import { type Logger } from '@false-route/observability';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export function errorHandlerMiddleware(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const correlationId = req.correlationId;

    if (err instanceof ZodError) {
      const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      const errorResponse: ApiErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: 'Invalid request payload or parameters',
        correlationId,
        details,
      };

      res.status(400).json(errorResponse);
      return;
    }

    if (err instanceof NotFoundError) {
      const errorResponse: ApiErrorResponse = {
        error: 'NOT_FOUND',
        message: err.message,
        correlationId,
      };

      res.status(404).json(errorResponse);
      return;
    }

    if (err instanceof ConflictError) {
      const errorResponse: ApiErrorResponse = {
        error: 'CONFLICT',
        message: err.message,
        correlationId,
      };

      res.status(409).json(errorResponse);
      return;
    }

    if (
      (err instanceof SyntaxError &&
        'status' in err &&
        (err as { status: number }).status === 400) ||
      (typeof err === 'object' &&
        err !== null &&
        'type' in err &&
        (err as { type: string }).type === 'entity.parse.failed')
    ) {
      const errorResponse: ApiErrorResponse = {
        error: 'BAD_REQUEST',
        message: 'Malformed JSON payload in request body',
        correlationId,
      };

      res.status(400).json(errorResponse);
      return;
    }

    if (
      (typeof err === 'object' &&
        err !== null &&
        'type' in err &&
        (err as { type: string }).type === 'entity.too.large') ||
      (typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 413) ||
      (typeof err === 'object' &&
        err !== null &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 413)
    ) {
      const errorResponse: ApiErrorResponse = {
        error: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds 64kb limit',
        correlationId,
      };

      res.status(413).json(errorResponse);
      return;
    }

    const errorType = err instanceof Error ? err.name : 'UnknownError';
    logger.error({ correlationId, errorType }, 'Unhandled internal server error');

    const errorResponse: ApiErrorResponse = {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred',
      correlationId,
    };

    res.status(500).json(errorResponse);
  };
}
