import { type Request, type Response, type NextFunction } from 'express';
import { UuidSchema } from '@false-route/contracts';
import { type CampaignService } from '../services/campaign-service.js';

export class CampaignController {
  constructor(private readonly service: CampaignService) {}

  start = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId =
        (res.locals['correlationId'] as string | undefined) ??
        (req.headers['x-correlation-id'] as string | undefined) ??
        `campaign-${Date.now()}`;
      res.status(202).json(await this.service.start(correlationId));
    } catch (error) {
      next(error);
    }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.get(UuidSchema.parse(req.params.id)));
    } catch (error) {
      next(error);
    }
  };
}
