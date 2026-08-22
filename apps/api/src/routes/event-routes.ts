import { Router } from 'express';
import { type EventController } from '../controllers/event-controller.js';

export function createEventRouter(controller: EventController): Router {
  const router = Router();

  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:id', controller.getById);
  router.get('/:id/decision', controller.getDecision);

  return router;
}
