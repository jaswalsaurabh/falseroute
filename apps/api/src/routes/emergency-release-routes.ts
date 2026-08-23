import { Router } from 'express';
import { type EmergencyReleaseController } from '../controllers/emergency-release-controller.js';

export interface EmergencyReleaseRouterOptions {
  readonly controller: EmergencyReleaseController;
}

export function createEmergencyReleaseRouter(options: EmergencyReleaseRouterOptions): Router {
  const router = Router();

  router.post('/', (req, res, next) => {
    void options.controller.handleEmergencyRelease(req, res, next);
  });

  return router;
}
