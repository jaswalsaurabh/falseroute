import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { type DatabaseClient } from '@false-route/database';
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

export interface AppOptions {
  readonly config: ApiConfig;
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly repository?: ApiRepository | undefined;
  readonly clock?: (() => number) | undefined;
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

  // Security Headers and CORS Origin Allowlist
  app.use(helmet());
  const allowedOrigins = config.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    }),
  );

  // Request Context, Load Shedding & Body Limits
  app.use(correlationMiddleware());
  app.use(express.json({ limit: '64kb' }));
  app.use(createOverloadGuard());

  // Early Principal Identification (attaches non-secret principal fingerprint for valid tokens)
  app.use(createPrincipalIdentifier({ expectedToken: config.OPERATOR_ACCESS_TOKEN }));

  // Global Default Quota Boundary (applies per-principal limit with IP fallback across all routes)
  const defaultLimiter = createRateLimiter({
    className: 'default',
    ...(clock !== undefined ? { clock } : {}),
  });
  app.use(defaultLimiter);

  // Component Composition
  const repository = options.repository ?? new PrismaApiRepository(db);
  const eventService = new EventService(repository);
  const eventController = new EventController(eventService);
  const healthController = new HealthController(repository);

  const authMiddleware = operatorAuthMiddleware({
    expectedToken: config.OPERATOR_ACCESS_TOKEN,
    ...(clock !== undefined ? { clock } : {}),
  });

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

  const eventRouter = createEventRouter({
    controller: eventController,
    readLimiter,
    writeLimiter,
  });
  app.use('/api/v1/intrusion-events', authMiddleware, eventRouter);

  // Unmatched Route Boundary
  app.use((req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  // Centralized Error Boundary
  app.use(errorHandlerMiddleware(logger));

  return app;
}
