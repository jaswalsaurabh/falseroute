import { createDatabaseClient, type DatabaseClient } from '@false-route/database';
import {
  createLogger,
  createTelemetry,
  type Logger,
  type TelemetryHandle,
} from '@false-route/observability';
import { parseWorkerConfig, type WorkerConfig } from './config/worker-config.js';
import { PrismaWorkerRepository, type WorkerRepository } from './persistence/worker-repository.js';
import { LiveGeminiAdapter, type GeminiEnrichmentAdapter } from './adapters/gemini-adapter.js';
import { FakeGeminiAdapter } from './adapters/fake-gemini-adapter.js';
import {
  DeterministicSimulatedDeceptionAdapter,
  type SimulatedDeceptionAgent,
} from './adapters/simulated-deception-agent.js';
import { EventProcessor } from './processor/event-processor.js';
import { WorkerOrchestrator } from './processor/worker-orchestrator.js';

export interface StartWorkerOptions {
  readonly config?: WorkerConfig | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly db?: DatabaseClient | undefined;
  readonly repository?: WorkerRepository | undefined;
  readonly geminiAdapter?: GeminiEnrichmentAdapter | undefined;
  readonly simulatedAgent?: SimulatedDeceptionAgent | undefined;
  readonly logger?: Logger | undefined;
  readonly telemetry?: TelemetryHandle | undefined;
  readonly registerSignalHandlers?: boolean | undefined;
  readonly onShutdownComplete?: ((exitCode: number) => void) | undefined;
}

export interface WorkerInstance {
  readonly config: WorkerConfig;
  readonly orchestrator: WorkerOrchestrator;
  readonly processor: EventProcessor;
  readonly db: DatabaseClient;
  readonly telemetry: TelemetryHandle;
  readonly logger: Logger;
  readonly isReady: () => boolean;
  readonly stop: (reason?: string) => Promise<void>;
}

/**
 * Starts the FalseRoute background worker with runtime lifecycle management,
 * durable claim lease protection, bounded shutdown timeouts, and sanitized logging.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerInstance> {
  const config = options.config ?? parseWorkerConfig(options.env ?? process.env);

  const logger =
    options.logger ??
    createLogger({
      serviceName: 'falseroute-worker',
      environment: config.NODE_ENV,
      level: config.LOG_LEVEL,
    });

  const telemetry =
    options.telemetry ??
    createTelemetry({
      serviceName: 'falseroute-worker',
      environment: config.NODE_ENV,
      enabled: config.ENABLE_TELEMETRY,
    });

  let isReadyState = false;
  const isReady = (): boolean => isReadyState;

  let db: DatabaseClient | null = null;
  let orchestrator: WorkerOrchestrator | null = null;

  try {
    db = options.db ?? createDatabaseClient({ connectionString: config.DATABASE_URL });
    await telemetry.init();

    const repository =
      options.repository ??
      new PrismaWorkerRepository(db, {
        claimLeaseDurationMs: config.WORKER_CLAIM_LEASE_MS,
        maxProcessingAttempts: config.WORKER_MAX_PROCESSING_ATTEMPTS,
      });

    let geminiAdapter: GeminiEnrichmentAdapter;
    if (options.geminiAdapter) {
      geminiAdapter = options.geminiAdapter;
    } else if (config.GEMINI_API_KEY) {
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

    const simulatedAgent = options.simulatedAgent ?? new DeterministicSimulatedDeceptionAdapter();

    const processor = new EventProcessor({
      repository,
      geminiAdapter,
      simulatedAgent,
      logger,
    });

    orchestrator = new WorkerOrchestrator({
      processor,
      logger,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    });

    orchestrator.start();
    isReadyState = true;
    logger.info('FalseRoute worker service initialized and polling');

    let shutdownPromise: Promise<void> | null = null;

    const stop = async (reason = 'manual'): Promise<void> => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        isReadyState = false;
        logger.info(
          { reason, timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
          'Worker shutdown initiated; stopping polling loop',
        );

        if (orchestrator) {
          const stopTask = orchestrator.stop();
          let shutdownTimer: NodeJS.Timeout | null = null;
          const timeoutTask = new Promise<void>((resolve) => {
            shutdownTimer = setTimeout(() => {
              logger.warn(
                { timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
                'Worker active claim exceeded shutdown deadline; exiting without false completion for lease recovery',
              );
              resolve();
            }, config.WORKER_SHUTDOWN_TIMEOUT_MS);
          });

          await Promise.race([stopTask, timeoutTask]);
          if (shutdownTimer) clearTimeout(shutdownTimer);
        }

        if (db) {
          try {
            await db.$disconnect();
          } catch (dbErr) {
            const errorType = dbErr instanceof Error ? dbErr.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Error disconnecting database during worker shutdown');
          }
        }

        try {
          await telemetry.shutdown();
        } catch (telErr) {
          const errorType = telErr instanceof Error ? telErr.constructor.name : 'UnknownError';
          logger.error({ errorType }, 'Error shutting down telemetry during worker shutdown');
        }

        logger.info('FalseRoute worker service shutdown cleanly');
      })();

      return shutdownPromise;
    };

    const instance: WorkerInstance = {
      config,
      orchestrator,
      processor,
      db,
      telemetry,
      logger,
      isReady,
      stop,
    };

    if (options.registerSignalHandlers) {
      let isSignalHandled = false;
      const handleSignal = (signal: string) => {
        if (isSignalHandled) return;
        isSignalHandled = true;
        logger.info({ signal }, 'Worker shutdown signal received');
        stop(signal).then(
          () => {
            if (options.onShutdownComplete) options.onShutdownComplete(0);
            else process.exit(0);
          },
          (err) => {
            const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Fatal error during worker shutdown');
            if (options.onShutdownComplete) options.onShutdownComplete(1);
            else process.exit(1);
          },
        );
      };

      process.once('SIGINT', () => handleSignal('SIGINT'));
      process.once('SIGTERM', () => handleSignal('SIGTERM'));
    }

    return instance;
  } catch (startupErr) {
    const errorType = startupErr instanceof Error ? startupErr.constructor.name : 'UnknownError';
    logger.error({ errorType }, 'Fatal worker startup error; aborting startup');

    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // Suppress secondary disconnect errors
      }
    }
    try {
      await telemetry.shutdown();
    } catch {
      // Suppress secondary telemetry errors
    }

    throw startupErr;
  }
}
