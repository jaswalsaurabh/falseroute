import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {
  ActivityEventRepository,
  AutonomousWorkflowRepository,
  PrismaClient,
  type DatabaseClient,
} from '@false-route/database';
import { type Logger } from '@false-route/observability';
import { type ApiConfig } from './config/api-config.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { createPrincipalIdentifier } from './middleware/principal.js';
import { operatorAuthMiddleware } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createOverloadGuard } from './middleware/load-shed.js';
import { errorHandlerMiddleware, NotFoundError } from './middleware/error-handler.js';
import { PrismaApiRepository, type ApiRepository } from './persistence/api-repository.js';
import { EventService } from './services/event-service.js';
import { EventController } from './controllers/event-controller.js';
import { HealthController } from './controllers/health-controller.js';
import { createEventRouter } from './routes/event-routes.js';
import { createHealthRouter } from './routes/health-routes.js';
import { ActivityStreamService } from './services/activity-stream-service.js';
import { createActivityRouter } from './routes/activity-routes.js';
import { DeadLetterService } from './services/dead-letter-service.js';
import { createDeadLetterRouter } from './routes/dead-letter-routes.js';
import { EmergencyReleaseService } from './services/emergency-release-service.js';
import { EmergencyReleaseController } from './controllers/emergency-release-controller.js';
import { OperatorController } from './controllers/operator-controller.js';
import { createEmergencyReleaseRouter } from './routes/emergency-release-routes.js';
import {
  InMemoryEventPublisher,
  LocalHttpEventPublisher,
  PubSubEmulatorEventPublisher,
  type EventPublisher,
} from './integrations/event-publisher.js';

export interface AppOptions {
  readonly config: ApiConfig;
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly repository?: ApiRepository | undefined;
  readonly activityRepo?: ActivityEventRepository | undefined;
  readonly streamService?: ActivityStreamService | undefined;
  readonly workflowRepo?: AutonomousWorkflowRepository | undefined;
  readonly deadLetterService?: DeadLetterService | undefined;
  readonly emergencyReleaseService?: EmergencyReleaseService | undefined;
  readonly eventPublisher?: EventPublisher | undefined;
  readonly clock?: (() => number) | undefined;
  readonly isReady?: (() => boolean) | undefined;
}

/**
 * Creates and configures the Express API application with full security baseline,
 * route composition, middleware pipeline, and error handling boundaries.
 */
export function createApp(options: AppOptions): Express {
  const { config, db, logger, clock } = options;

  const app = express();

  // Source-IP resolution trusts declared reverse-proxy hops only; 0 hops
  // (default) fails closed and ignores client-supplied forwarding headers.
  if ((config.TRUST_PROXY_HOPS ?? 0) > 0) {
    app.set('trust proxy', config.TRUST_PROXY_HOPS);
  }

  // Security Headers and CORS Origin Allowlist (preflightContinue allows quota controls before preflight response)
  app.use(helmet());
  const allowedOrigins = config.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Correlation-Id',
        'X-Replay-Authorization',
      ],
      preflightContinue: true,
    }),
  );

  // Request Context, Load Shedding & Abuse Boundaries before body parsing
  app.use(correlationMiddleware());
  app.use(createOverloadGuard());

  // Early Principal Identification (attaches non-secret principal fingerprint for valid tokens)
  app.use(createPrincipalIdentifier({ expectedToken: config.OPERATOR_ACCESS_TOKEN }));

  // Global Default Quota Boundary (applies per-principal limit with IP fallback and secondary IP boundary)
  const defaultLimiter = createRateLimiter({
    className: 'default',
    secondaryKeyMode: 'ip',
    ...(clock !== undefined ? { clock } : {}),
  });
  app.use(defaultLimiter);

  // Explicit Preflight Terminator (after CORS headers set and rate limiting evaluated)
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request Body Limits & Parsing (executed only after overload and default rate limit pass)
  app.use(express.json({ limit: '64kb' }));

  // Component Composition
  const repository = options.repository ?? new PrismaApiRepository(db);
  const eventPublisher =
    options.eventPublisher ??
    (config.EVENT_PUBLISHER_MODE === 'LOCAL_HTTP' && config.LOCAL_WORKER_PUSH_TOKEN
      ? new LocalHttpEventPublisher({
          endpoint: config.LOCAL_WORKER_PUSH_URL ?? 'http://127.0.0.1:8088/pubsub/push',
          sharedSecret: config.LOCAL_WORKER_PUSH_TOKEN,
          timeoutMs: config.EVENT_PUBLISH_TIMEOUT_MS ?? 5000,
        })
      : config.EVENT_PUBLISHER_MODE === 'PUBSUB_EMULATOR'
        ? new PubSubEmulatorEventPublisher({
            projectId: config.PUBSUB_PROJECT_ID!,
            topicId: config.PUBSUB_TOPIC_ID ?? 'falseroute-events',
            emulatorHost: config.PUBSUB_EMULATOR_HOST!,
            timeoutMs: config.EVENT_PUBLISH_TIMEOUT_MS ?? 5000,
          })
        : new InMemoryEventPublisher());
  if (config.EVENT_PUBLISHER_MODE === 'LIVE_PUBSUB' && !options.eventPublisher) {
    throw new Error('LIVE_PUBSUB requires an explicitly injected production EventPublisher');
  }
  const eventService = new EventService(repository, eventPublisher);
  const eventController = new EventController(eventService);
  const healthController = new HealthController(repository, options.isReady);

  const activityRepo = options.activityRepo ?? new ActivityEventRepository(db as PrismaClient);
  const streamService = options.streamService ?? new ActivityStreamService(activityRepo);
  const workflowRepo = options.workflowRepo ?? new AutonomousWorkflowRepository(db as PrismaClient);
  const deadLetterService =
    options.deadLetterService ?? new DeadLetterService(workflowRepo, eventPublisher);

  const authMiddleware = operatorAuthMiddleware({
    expectedToken: config.OPERATOR_ACCESS_TOKEN,
    ...(clock !== undefined ? { clock } : {}),
  });
  const operatorController = new OperatorController();

  // Stricter request-class budgets (process-local, see config/rate-limits.ts)
  const readLimiter = createRateLimiter({
    className: 'read',
    secondaryKeyMode: 'ip',
    ...(clock !== undefined ? { clock } : {}),
  });
  const writeLimiter = createRateLimiter({
    className: 'write',
    secondaryKeyMode: 'ip',
    ...(clock !== undefined ? { clock } : {}),
  });
  const healthLimiter = createRateLimiter({
    className: 'health',
    keyMode: 'ip',
    ...(clock !== undefined ? { clock } : {}),
  });

  // Mount API Endpoints
  const healthRouter = createHealthRouter({
    controller: healthController,
    authMiddleware,
    healthLimiter,
  });
  app.use('/api/v1', healthRouter);

  // Keep authentication verification independent from event-store reads. This
  // is important during a staged schema rollout: a valid operator must not be
  // reported as unauthenticated because an unrelated list query failed.
  app.get('/api/v1/operator/session', authMiddleware, operatorController.session);

  const eventRouter = createEventRouter({
    controller: eventController,
    readLimiter,
    writeLimiter,
  });
  app.use('/api/v1/intrusion-events', authMiddleware, eventRouter);

  const activityRouter = createActivityRouter({
    streamService,
  });
  app.use('/api/v1/activity', authMiddleware, activityRouter);

  const deadLetterRouter = createDeadLetterRouter({
    deadLetterService,
    replayToken: config.OPERATOR_REPLAY_TOKEN,
  });
  app.use('/api/v1/dead-letter', authMiddleware, deadLetterRouter);

  // No simulated-provider adapter is wired by default: the simulated inventory lives in the
  // Worker process, so the API cannot observe it and must never claim a provider effect it did
  // not verify. Route and quarantine leases are left pending and immediately eligible for the
  // Worker cleanup sweep, which owns that inventory.
  const emergencyReleaseService =
    options.emergencyReleaseService ?? new EmergencyReleaseService(workflowRepo, activityRepo);
  const emergencyReleaseController = new EmergencyReleaseController(emergencyReleaseService);
  const emergencyReleaseRouter = createEmergencyReleaseRouter({
    controller: emergencyReleaseController,
  });
  app.use('/api/v1/operator/emergency-release', authMiddleware, emergencyReleaseRouter);
  app.use('/api/v1/emergency-release', authMiddleware, emergencyReleaseRouter);

  // Unmatched Route Boundary
  app.use((req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  // Centralized Error Boundary
  app.use(errorHandlerMiddleware(logger));

  return app;
}
