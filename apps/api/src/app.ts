import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { type DatabaseClient } from '@false-route/database';
import { type Logger } from '@false-route/observability';
import { type ApiConfig } from './config/api-config.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { operatorAuthMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
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
}

/**
 * Creates and configures the Express API application with full security baseline,
 * route composition, middleware pipeline, and error handling boundaries.
 */
export function createApp(options: AppOptions): Express {
  const { config, db, logger } = options;

  const app = express();

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

  // Request Context & Security Limiting
  app.use(correlationMiddleware());
  app.use(express.json({ limit: '64kb' }));
  app.use(rateLimitMiddleware());

  // Component Composition
  const repository = options.repository ?? new PrismaApiRepository(db);
  const eventService = new EventService(repository);
  const eventController = new EventController(eventService);
  const healthController = new HealthController(repository);

  const authMiddleware = operatorAuthMiddleware({
    expectedToken: config.OPERATOR_ACCESS_TOKEN,
  });

  // Mount API Endpoints
  const healthRouter = createHealthRouter(healthController, authMiddleware);
  app.use('/api/v1', healthRouter);

  const eventRouter = createEventRouter(eventController);
  app.use('/api/v1/intrusion-events', authMiddleware, eventRouter);

  // Fallback 404 Handler
  app.use((req, _res, next) => {
    next(new NotFoundError(`Endpoint not found: ${req.method} ${req.originalUrl}`));
  });

  // Outer Error Boundary
  app.use(errorHandlerMiddleware(logger));

  return app;
}
