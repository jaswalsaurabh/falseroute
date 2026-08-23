import { Router, type RequestHandler } from 'express';
import { type HealthController } from '../controllers/health-controller.js';

export interface HealthRouterHandlers {
  readonly controller: HealthController;
  readonly healthLimiter: RequestHandler;
  readonly authMiddleware?: RequestHandler | undefined;
}

export function createHealthRouter(handlers: HealthRouterHandlers): Router {
  const { controller, healthLimiter } = handlers;
  const router = Router();

  router.get('/health', healthLimiter, controller.liveness);
  router.get('/ready', healthLimiter, controller.readiness);

  return router;
}
