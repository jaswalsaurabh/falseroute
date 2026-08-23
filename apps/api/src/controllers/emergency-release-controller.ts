import type { Request, Response, NextFunction } from 'express';
import { EmergencyReleaseRequestSchema } from '@false-route/contracts';
import { type EmergencyReleaseService } from '../services/emergency-release-service.js';

export class EmergencyReleaseController {
  constructor(private readonly service: EmergencyReleaseService) {}

  async handleEmergencyRelease(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = EmergencyReleaseRequestSchema.parse(req.body);
      const correlationId =
        (res.locals['correlationId'] as string | undefined) ??
        (req.headers['x-correlation-id'] as string | undefined) ??
        'corr-emergency-release';

      const principalId =
        (req as Request & { principalId?: string }).principalId ??
        (req as Request & { user?: { principalId?: string; id?: string } }).user?.principalId ??
        'operator-principal';

      const result = await this.service.executeEmergencyRelease(
        validated,
        correlationId,
        principalId,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
