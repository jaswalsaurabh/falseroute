import { Router, type RequestHandler } from 'express';
import { type CampaignController } from '../controllers/campaign-controller.js';

export function createCampaignRouter(options: {
  readonly controller: CampaignController;
  readonly readLimiter: RequestHandler;
  readonly writeLimiter: RequestHandler;
}): Router {
  const router = Router();
  router.post('/', options.writeLimiter, options.controller.start);
  router.get('/:id', options.readLimiter, options.controller.get);
  return router;
}
