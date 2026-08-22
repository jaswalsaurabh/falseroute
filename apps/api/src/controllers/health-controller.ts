import { type Request, type Response } from 'express';
import {
  HealthCheckResponseSchema,
  ReadinessCheckResponseSchema,
  type ApiErrorResponse,
} from '@false-route/contracts';
import { type ApiRepository } from '../persistence/api-repository.js';

export class HealthController {
  constructor(
    private readonly repository: ApiRepository,
    private readonly isReadySupplier?: (() => boolean) | undefined,
  ) {}

  liveness = (_req: Request, res: Response): void => {
    const response = HealthCheckResponseSchema.parse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(response);
  };

  readiness = async (req: Request, res: Response): Promise<void> => {
    if (this.isReadySupplier && !this.isReadySupplier()) {
      const errorResponse: ApiErrorResponse = {
        error: 'SERVICE_UNAVAILABLE',
        message: 'Server is shutting down',
        correlationId: req.correlationId,
      };
      res.status(503).json(errorResponse);
      return;
    }

    const isHealthy = await this.repository.checkHealth();

    // Guard against shutdown initiated while the database check was in flight
    if (this.isReadySupplier && !this.isReadySupplier()) {
      const errorResponse: ApiErrorResponse = {
        error: 'SERVICE_UNAVAILABLE',
        message: 'Server is shutting down',
        correlationId: req.correlationId,
      };
      res.status(503).json(errorResponse);
      return;
    }

    if (!isHealthy) {
      const errorResponse: ApiErrorResponse = {
        error: 'SERVICE_UNAVAILABLE',
        message: 'Database connection failed',
        correlationId: req.correlationId,
      };
      res.status(503).json(errorResponse);
      return;
    }

    const response = ReadinessCheckResponseSchema.parse({
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(response);
  };
}
