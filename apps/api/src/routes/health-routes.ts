import { Router, type RequestHandler } from 'express';
import { type HealthController } from '../controllers/health-controller.js';

export function createHealthRouter(
  controller: HealthController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.get('/health', controller.liveness);
  router.get('/ready', authMiddleware, controller.readiness);

  return router;
}
