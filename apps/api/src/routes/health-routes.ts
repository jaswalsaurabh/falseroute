import { Router, type RequestHandler } from 'express';
import { type HealthController } from '../controllers/health-controller.js';

export interface HealthRouterHandlers {
  readonly controller: HealthController;
  readonly authMiddleware: RequestHandler;
  readonly healthLimiter: RequestHandler;
}

export function createHealthRouter(handlers: HealthRouterHandlers): Router {
  const { controller, authMiddleware, healthLimiter } = handlers;
  const router = Router();

  router.get('/health', healthLimiter, controller.liveness);
  router.get('/ready', authMiddleware, healthLimiter, controller.readiness);

  return router;
}
