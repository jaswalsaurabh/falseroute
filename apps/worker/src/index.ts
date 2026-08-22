import { createDatabaseClient } from '@false-route/database';
import { createLogger, createTelemetry } from '@false-route/observability';
import { parseWorkerConfig } from './config/worker-config.js';
import { PrismaWorkerRepository } from './persistence/worker-repository.js';
import { LiveGeminiAdapter, type GeminiEnrichmentAdapter } from './adapters/gemini-adapter.js';
import { FakeGeminiAdapter } from './adapters/fake-gemini-adapter.js';
import { EventProcessor } from './processor/event-processor.js';
import { WorkerOrchestrator } from './processor/worker-orchestrator.js';

export {
  evaluateDeceptionPolicy,
  ACTIVE_RULE_VERSION,
  type PolicyEvaluationInput,
} from './domain/policy-engine.js';
export {
  LiveGeminiAdapter,
  type GeminiAdapterOptions,
  type GeminiEnrichmentAdapter,
} from './adapters/gemini-adapter.js';
export {
  FakeGeminiAdapter,
  type FakeAdapterMode,
  type FakeAdapterOptions,
} from './adapters/fake-gemini-adapter.js';
export {
  ConcurrencyLimiter,
  ConcurrencySaturationError,
  type ConcurrencyLimiterOptions,
} from './adapters/concurrency-limiter.js';
export {
  classifyProviderError,
  extractHttpStatus,
  sanitizeErrorMessage,
  type ClassifiedProviderError,
  type ProviderErrorKind,
} from './adapters/error-classifier.js';
export { PrismaWorkerRepository, type WorkerRepository } from './persistence/worker-repository.js';
export {
  EventProcessor,
  type EventProcessorOptions,
  type ProcessResult,
} from './processor/event-processor.js';
export { WorkerOrchestrator, type OrchestratorOptions } from './processor/worker-orchestrator.js';

async function main() {
  const config = parseWorkerConfig(process.env);

  const logger = createLogger({
    serviceName: 'falseroute-worker',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const telemetry = createTelemetry({
    serviceName: 'falseroute-worker',
    environment: config.NODE_ENV,
    enabled: config.ENABLE_TELEMETRY,
  });

  await telemetry.init();

  const db = createDatabaseClient({ connectionString: config.DATABASE_URL });
  const repository = new PrismaWorkerRepository(db, {
    claimLeaseDurationMs: config.WORKER_CLAIM_LEASE_MS,
    maxProcessingAttempts: config.WORKER_MAX_PROCESSING_ATTEMPTS,
  });

  let geminiAdapter: GeminiEnrichmentAdapter;
  if (config.GEMINI_API_KEY) {
    logger.info(
      {
        model: config.GEMINI_MODEL,
        requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
        operationDeadlineMs: config.GEMINI_OPERATION_DEADLINE_MS,
        maxRetries: config.GEMINI_MAX_RETRIES,
        maxConcurrency: config.GEMINI_MAX_CONCURRENCY,
      },
      'Initializing Live Gemini adapter with bounded failure isolation',
    );
    geminiAdapter = new LiveGeminiAdapter({
      apiKey: config.GEMINI_API_KEY,
      modelName: config.GEMINI_MODEL,
      requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
      operationDeadlineMs: config.GEMINI_OPERATION_DEADLINE_MS,
      maxRetries: config.GEMINI_MAX_RETRIES,
      maxConcurrency: config.GEMINI_MAX_CONCURRENCY,
      maxQueueSize: config.GEMINI_MAX_QUEUE_SIZE,
    });
  } else {
    logger.warn('No GEMINI_API_KEY provided; AI enrichment is unavailable (degraded state)');
    geminiAdapter = new FakeGeminiAdapter('unavailable');
  }

  const processor = new EventProcessor({
    repository,
    geminiAdapter,
    logger,
  });

  const orchestrator = new WorkerOrchestrator({
    processor,
    logger,
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await orchestrator.stop();
    await db.$disconnect();
    await telemetry.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  orchestrator.start();
}

// Run main only when executed directly
if (process.argv[1]?.endsWith('dist/index.js') || process.argv[1]?.endsWith('src/index.ts')) {
  main().catch((err) => {
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    console.error(`Fatal worker startup error: [${errorType}]`);
    process.exit(1);
  });
}
