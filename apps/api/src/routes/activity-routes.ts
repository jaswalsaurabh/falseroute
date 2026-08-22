import { Router, type Request, type Response, type NextFunction } from 'express';
import { type ActivityStreamService } from '../services/activity-stream-service.js';

export interface ActivityRouterOptions {
  readonly streamService: ActivityStreamService;
}

export function createActivityRouter(options: ActivityRouterOptions): Router {
  const router = Router();
  const { streamService } = options;

  // Snapshot list endpoint for initial page load and reconnection repair
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(async () => {
        const sinceCursorParam = req.query['sinceCursor'];
        const limitParam = req.query['limit'];

        const limit =
          typeof limitParam === 'string' ? Math.min(parseInt(limitParam, 10) || 50, 100) : 50;

        if (typeof sinceCursorParam === 'string') {
          const sinceCursor = parseInt(sinceCursorParam, 10) || 0;
          res.json(await streamService.getSnapshot(sinceCursor, limit));
          return;
        }

        res.json(await streamService.getSnapshot(undefined, limit));
      })
      .catch(next);
  });

  // Resumable Server-Sent Events stream endpoint
  router.get('/stream', (req: Request, res: Response, next: NextFunction) => {
    const lastEventIdHeader = req.headers['last-event-id'];
    let lastEventId: number | undefined;

    if (typeof lastEventIdHeader === 'string') {
      const parsed = parseInt(lastEventIdHeader, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        lastEventId = parsed;
      }
    }

    void streamService.registerClient(res, lastEventId).catch(next);
  });

  return router;
}
