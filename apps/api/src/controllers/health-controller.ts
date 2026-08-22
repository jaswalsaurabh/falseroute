import { type Request, type Response } from 'express';
import {
  HealthCheckResponseSchema,
  ReadinessCheckResponseSchema,
  type ApiErrorResponse,
} from '@false-route/contracts';
import { type ApiRepository } from '../persistence/api-repository.js';

export class HealthController {
  constructor(private readonly repository: ApiRepository) {}

  liveness = (_req: Request, res: Response): void => {
    const response = HealthCheckResponseSchema.parse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(response);
  };

  readiness = async (req: Request, res: Response): Promise<void> => {
    const isHealthy = await this.repository.checkHealth();
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
