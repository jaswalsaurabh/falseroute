import { createDatabaseClient } from '@false-route/database';
import { createLogger, createTelemetry } from '@false-route/observability';
import { parseApiConfig } from './config/api-config.js';
import { createApp } from './app.js';

export { createApp, type AppOptions } from './app.js';
export { parseApiConfig, type ApiConfig } from './config/api-config.js';
export { PrismaApiRepository, type ApiRepository } from './persistence/api-repository.js';
export { EventService } from './services/event-service.js';
export { EventController } from './controllers/event-controller.js';
export { HealthController } from './controllers/health-controller.js';

async function main() {
  const config = parseApiConfig(process.env);

  const logger = createLogger({
    serviceName: 'falseroute-api',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const telemetry = createTelemetry({
    serviceName: 'falseroute-api',
    environment: config.NODE_ENV,
    enabled: config.ENABLE_TELEMETRY,
  });

  await telemetry.init();

  const db = createDatabaseClient({ connectionString: config.DATABASE_URL });
  const app = createApp({ config, db, logger });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'FalseRoute API server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'API shutdown signal received');
    server.close(async () => {
      await db.$disconnect();
      await telemetry.shutdown();
      logger.info('API server closed cleanly');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1]?.endsWith('dist/index.js') || process.argv[1]?.endsWith('src/index.ts')) {
  main().catch((err) => {
    console.error('Fatal API startup error:', err);
    process.exit(1);
  });
}
