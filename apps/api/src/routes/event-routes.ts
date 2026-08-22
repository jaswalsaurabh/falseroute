import { Router, type RequestHandler } from 'express';
import { type EventController } from '../controllers/event-controller.js';

export interface EventRouterHandlers {
  readonly controller: EventController;
  readonly readLimiter: RequestHandler;
  readonly writeLimiter: RequestHandler;
}

export function createEventRouter(handlers: EventRouterHandlers): Router {
  const { controller, readLimiter, writeLimiter } = handlers;
  const router = Router();

  router.post('/', writeLimiter, controller.create);
  router.get('/', readLimiter, controller.list);
  router.get('/:id', readLimiter, controller.getById);
  router.get('/:id/decision', readLimiter, controller.getDecision);

  return router;
}
