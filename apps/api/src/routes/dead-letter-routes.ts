import { Router, type Request, type Response, type NextFunction } from 'express';
import { ReplayDeadLetterRequestSchema } from '@false-route/contracts';
import { extractBearerToken, verifyOperatorToken } from '@false-route/security';
import { type DeadLetterService } from '../services/dead-letter-service.js';
import { computeCredentialFingerprint } from '../middleware/principal.js';

export interface DeadLetterRouterOptions {
  readonly deadLetterService: DeadLetterService;
  readonly replayToken?: string | undefined;
}

export function createDeadLetterRouter(options: DeadLetterRouterOptions): Router {
  const router = Router();
  const { deadLetterService } = options;

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await deadLetterService.listRecords();
      res.json({ records });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/replay', (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(async () => {
        const paramId = req.params['id'];
        const deadLetterId = Array.isArray(paramId) ? paramId[0] : paramId;
        if (!deadLetterId) {
          res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing dead letter ID' });
          return;
        }

        if (!options.replayToken) {
          res.status(503).json({
            error: 'REPLAY_DISABLED',
            message: 'DLQ replay reauthorization is not configured',
          });
          return;
        }

        const replayHeader = req.header('X-Replay-Authorization');
        const replayCredential = extractBearerToken(replayHeader);
        if (
          replayCredential === null ||
          !verifyOperatorToken(replayCredential, options.replayToken)
        ) {
          res.status(403).json({
            error: 'REAUTHORIZATION_REQUIRED',
            message: 'A distinct elevated replay authorization is required',
          });
          return;
        }

        const validation = ReplayDeadLetterRequestSchema.safeParse(req.body);
        if (!validation.success) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Invalid replay request payload',
            details: validation.error.issues,
          });
          return;
        }
        if (validation.data.deadLetterId !== deadLetterId) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Replay payload deadLetterId must match the route identifier',
          });
          return;
        }

        try {
          const result = await deadLetterService.replayRecord(
            deadLetterId,
            computeCredentialFingerprint(replayCredential, 'replay-operator'),
            validation.data.rationale,
          );
          res.status(202).json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: 'REPLAY_FAILED', message });
        }
      })
      .catch(next);
  });

  return router;
}
