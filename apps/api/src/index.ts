import { startApiServer } from './lifecycle.js';

export { createApp, type AppOptions } from './app.js';
export { parseApiConfig, type ApiConfig } from './config/api-config.js';
export { PrismaApiRepository, type ApiRepository } from './persistence/api-repository.js';
export { EventService } from './services/event-service.js';
export { EventController } from './controllers/event-controller.js';
export { HealthController } from './controllers/health-controller.js';
export { startApiServer, type ApiServerInstance, type StartApiServerOptions } from './lifecycle.js';

async function main() {
  await startApiServer({ registerSignalHandlers: true });
}

if (process.argv[1]?.endsWith('dist/index.js') || process.argv[1]?.endsWith('src/index.ts')) {
  main().catch((err) => {
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    console.error(`Fatal API startup error: [${errorType}]`);
    process.exit(1);
  });
}
