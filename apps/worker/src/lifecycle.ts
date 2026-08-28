import http from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  ActivityEventRepository,
  AutonomousWorkflowRepository,
  CampaignRepository,
  BudgetRepository,
  PrismaClient,
  createDatabaseClient,
  type DatabaseClient,
} from '@false-route/database';
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
import { AutonomousWorkflowOrchestrator } from './orchestration/autonomous-workflow.js';
import {
  CampaignOrchestrator,
  type CampaignEventPublisher,
} from './orchestration/campaign-orchestrator.js';
import {
  type AutonomousGeminiAdapter,
  LiveAutonomousGeminiAdapter,
} from './adapters/autonomous-gemini-adapter.js';
import { FakeAutonomousGeminiAdapter } from './adapters/fake-autonomous-gemini-adapter.js';
import {
  LocalSharedSecretOidcTokenVerifier,
  PubSubEmulatorTokenVerifier,
  GoogleOidcTokenVerifier,
  PubSubPushHandler,
  type OidcTokenVerifier,
} from './integrations/pubsub-push-handler.js';
import { LeaseCleanupService } from './cleanup/lease-cleanup.js';
import { GeminiBudgetService } from './services/gemini-budget-service.js';
import { createGeminiMetrics } from './observability/gemini-metrics.js';
import { ToolGateway } from './tools/tool-gateway.js';
import {
  FakeCloudRunAdapter,
  FakeFalseRouteAdapter,
  FakeCloudArmorAdapter,
} from './tools/fake-cloud-adapters.js';
import { GooglePubSubEventPublisher } from './integrations/pubsub-event-publisher.js';

export interface StartWorkerOptions {
  readonly config?: WorkerConfig | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly db?: DatabaseClient | undefined;
  readonly repository?: WorkerRepository | undefined;
  readonly geminiAdapter?: GeminiEnrichmentAdapter | undefined;
  readonly autonomousGeminiAdapter?: AutonomousGeminiAdapter | undefined;
  readonly simulatedAgent?: SimulatedDeceptionAgent | undefined;
  readonly logger?: Logger | undefined;
  readonly telemetry?: TelemetryHandle | undefined;
  readonly autonomousOrchestrator?: AutonomousWorkflowOrchestrator | undefined;
  readonly autonomousWorkflowRepository?: AutonomousWorkflowRepository | undefined;
  readonly campaignRepository?: CampaignRepository | undefined;
  readonly activityEventRepository?: ActivityEventRepository | undefined;
  readonly leaseCleanupService?: LeaseCleanupService | undefined;
  readonly pushHandler?: PubSubPushHandler | undefined;
  readonly campaignPublisher?: CampaignEventPublisher | undefined;
  readonly oidcTokenVerifier?: OidcTokenVerifier | undefined;
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
  readonly healthServer: http.Server | null;
  readonly pushHandler: PubSubPushHandler | null;
  readonly cleanupService: LeaseCleanupService | null;
  readonly isReady: () => boolean;
  readonly stop: (reason?: string) => Promise<void>;
}

async function readBoundedJsonBody(
  req: http.IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBytes) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Starts the FalseRoute background worker with runtime lifecycle management,
 * Cloud Run-compatible HTTP health server, discrete readiness states, durable
 * claim lease protection, bounded shutdown timeouts, and sanitized logging.
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
  const geminiMetrics = createGeminiMetrics(telemetry.meter);

  let isReadyState = false;
  let isStopping = false;
  const isReady = (): boolean => isReadyState && !isStopping;

  let db: DatabaseClient | null = null;
  let orchestrator: WorkerOrchestrator | null = null;
  let pushHandler: PubSubPushHandler | null = null;
  let healthServer: http.Server | null = null;
  const trackedSockets = new Set<Socket>();

  try {
    db = options.db ?? createDatabaseClient({ connectionString: config.DATABASE_URL });
    await telemetry.init();

    const repository =
      options.repository ??
      new PrismaWorkerRepository(db, {
        claimLeaseDurationMs: config.WORKER_CLAIM_LEASE_MS,
        maxProcessingAttempts: config.WORKER_MAX_PROCESSING_ATTEMPTS,
      });

    // 1. Validate database connectivity prior to declaring readiness
    const dbHealthy = await repository.checkHealth();
    if (!dbHealthy) {
      throw new Error('Initial database connectivity check failed during worker startup');
    }

    let geminiAdapter: GeminiEnrichmentAdapter;
    if (options.geminiAdapter) {
      geminiAdapter = options.geminiAdapter;
    } else if (config.GEMINI_API_KEY) {
      logger.info(
        { model: config.GEMINI_MODEL, maxConcurrency: config.GEMINI_MAX_CONCURRENCY },
        'Initializing Live Gemini adapter with bounded failure isolation',
      );
      geminiAdapter = new LiveGeminiAdapter({
        apiKey: config.GEMINI_API_KEY,
        modelName: config.GEMINI_MODEL,
        requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
        operationDeadlineMs: config.GEMINI_OPERATION_DEADLINE_MS,
        maxRetries: config.GEMINI_MAX_RETRIES,
        initialDelayMs: config.GEMINI_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: config.GEMINI_RETRY_MAX_DELAY_MS,
        backoffMultiplier: config.GEMINI_RETRY_BACKOFF_MULTIPLIER,
        maxConcurrency: config.GEMINI_MAX_CONCURRENCY,
        maxQueueSize: config.GEMINI_MAX_QUEUE_SIZE,
        metrics: geminiMetrics,
      });
    } else {
      logger.warn('No GEMINI_API_KEY provided; AI enrichment is unavailable (degraded state)');
      geminiAdapter = new FakeGeminiAdapter('unavailable');
    }

    const simulatedAgent = options.simulatedAgent ?? new DeterministicSimulatedDeceptionAdapter();
    const budgetRepo = new BudgetRepository(db as PrismaClient);
    const budgetService = new GeminiBudgetService({
      budgetRepo,
      dailyTokenLimit: config.GEMINI_DAILY_TOKEN_LIMIT,
    });

    const sharedCloudRunAdapter = new FakeCloudRunAdapter();
    const sharedFalseRouteAdapter = new FakeFalseRouteAdapter();
    const sharedCloudArmorAdapter = new FakeCloudArmorAdapter();

    const processor = new EventProcessor({
      repository,
      geminiAdapter,
      simulatedAgent,
      logger,
      budgetService,
    });

    let cleanupService: LeaseCleanupService | null = null;
    let campaignOrchestrator: CampaignOrchestrator | undefined;

    if (config.AUTONOMOUS_PUSH_MODE !== 'DISABLED') {
      const workflowRepo =
        options.autonomousWorkflowRepository ??
        new AutonomousWorkflowRepository(db as PrismaClient);
      const activityRepo =
        options.activityEventRepository ?? new ActivityEventRepository(db as PrismaClient);

      cleanupService =
        options.leaseCleanupService ??
        new LeaseCleanupService(workflowRepo, activityRepo, {
          cloudRunAdapter: sharedCloudRunAdapter,
          falseRouteAdapter: sharedFalseRouteAdapter,
          cloudArmorAdapter: sharedCloudArmorAdapter,
        });

      const autoGeminiAdapter =
        options.autonomousGeminiAdapter ??
        (config.GEMINI_API_KEY
          ? new LiveAutonomousGeminiAdapter({
              apiKey: config.GEMINI_API_KEY,
              modelName: config.GEMINI_MODEL,
              requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
              operationDeadlineMs: config.GEMINI_OPERATION_DEADLINE_MS,
              maxRetries: config.GEMINI_MAX_RETRIES,
              initialDelayMs: config.GEMINI_RETRY_INITIAL_DELAY_MS,
              maxDelayMs: config.GEMINI_RETRY_MAX_DELAY_MS,
              backoffMultiplier: config.GEMINI_RETRY_BACKOFF_MULTIPLIER,
              maxConcurrency: config.GEMINI_MAX_CONCURRENCY,
              maxQueueSize: config.GEMINI_MAX_QUEUE_SIZE,
              metrics: geminiMetrics,
            })
          : new FakeAutonomousGeminiAdapter('unavailable'));

      const workerProcessId = `worker-${randomUUID()}`;
      const toolGateway = new ToolGateway(workflowRepo, activityRepo, {
        cloudRunAdapter: sharedCloudRunAdapter,
        falseRouteAdapter: sharedFalseRouteAdapter,
        cloudArmorAdapter: sharedCloudArmorAdapter,
        workerId: workerProcessId,
      });

      const autonomousOrchestrator =
        options.autonomousOrchestrator ??
        new AutonomousWorkflowOrchestrator(
          workflowRepo,
          activityRepo,
          toolGateway,
          autoGeminiAdapter,
          budgetService,
          workerProcessId,
        );

      const campaignRepository =
        options.campaignRepository ?? new CampaignRepository(db as PrismaClient);
      let campaignPublisher = options.campaignPublisher;
      if (!campaignPublisher && config.AUTONOMOUS_PUSH_MODE === 'OIDC') {
        if (!config.PUBSUB_PROJECT_ID) {
          throw new Error('OIDC campaign continuation requires PUBSUB_PROJECT_ID');
        }
        campaignPublisher = new GooglePubSubEventPublisher({
          projectId: config.PUBSUB_PROJECT_ID,
          topicId: config.PUBSUB_TOPIC_ID,
        });
      }
      campaignPublisher ??= {
        publish: async (envelope) => {
          const transportId = `campaign-${randomUUID()}`;
          await campaignOrchestrator!.process(envelope, transportId);
          return { transportId };
        },
      };
      campaignOrchestrator = new CampaignOrchestrator(
        campaignRepository,
        activityRepo,
        campaignPublisher,
        autonomousOrchestrator,
      );

      let verifier: OidcTokenVerifier;
      if (config.AUTONOMOUS_PUSH_MODE === 'LOCAL_SHARED_SECRET') {
        verifier = new LocalSharedSecretOidcTokenVerifier(config.AUTONOMOUS_LOCAL_PUSH_TOKEN!);
      } else if (config.AUTONOMOUS_PUSH_MODE === 'PUBSUB_EMULATOR') {
        verifier = new PubSubEmulatorTokenVerifier();
      } else {
        verifier = options.oidcTokenVerifier ?? new GoogleOidcTokenVerifier(undefined, logger);
      }

      pushHandler =
        options.pushHandler ??
        new PubSubPushHandler(
          autonomousOrchestrator,
          verifier,
          workflowRepo,
          {
            ...(config.PUBSUB_OIDC_AUDIENCE
              ? { expectedAudience: config.PUBSUB_OIDC_AUDIENCE }
              : {}),
            ...(config.PUBSUB_OIDC_SERVICE_ACCOUNT
              ? { expectedServiceAccount: config.PUBSUB_OIDC_SERVICE_ACCOUNT }
              : {}),
          },
          campaignOrchestrator,
        );
    }

    orchestrator = new WorkerOrchestrator({
      processor,
      logger,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      cleanupService: cleanupService ?? undefined,
      resumeCampaigns: campaignOrchestrator
        ? () => campaignOrchestrator!.resumeReadyCampaigns()
        : undefined,
    });

    // 2. Start Cloud Run-compatible HTTP health server
    healthServer = http.createServer(async (req, res) => {
      const urlPath = (req.url || '/').split('?')[0] || '/';
      res.setHeader('Content-Type', 'application/json');

      if (urlPath === '/pubsub/push') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }));
          return;
        }
        if (!pushHandler) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Push intake is disabled' }));
          return;
        }
        try {
          const body = await readBoundedJsonBody(req);
          const result = await pushHandler.handlePushRequest(req.headers.authorization, body);
          res.writeHead(result.statusCode);
          res.end(JSON.stringify(result.body));
        } catch (err) {
          const tooLarge = err instanceof Error && err.message === 'REQUEST_BODY_TOO_LARGE';
          res.writeHead(tooLarge ? 413 : 400);
          res.end(
            JSON.stringify({
              error: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
              message: tooLarge ? 'Push payload exceeds 64KB' : 'Push payload must be valid JSON',
            }),
          );
        }
        return;
      }

      if (urlPath === '/pubsub/dead-letter') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }));
          return;
        }
        if (!pushHandler) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Push intake is disabled' }));
          return;
        }
        try {
          const body = await readBoundedJsonBody(req);
          const result = await pushHandler.handleDeadLetterRequest(req.headers.authorization, body);
          res.writeHead(result.statusCode);
          res.end(JSON.stringify(result.body));
        } catch (err) {
          const tooLarge = err instanceof Error && err.message === 'REQUEST_BODY_TOO_LARGE';
          res.writeHead(tooLarge ? 413 : 400);
          res.end(
            JSON.stringify({
              error: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
              message: tooLarge ? 'Push payload exceeds 64KB' : 'Push payload must be valid JSON',
            }),
          );
        }
        return;
      }

      if (urlPath === '/cleanup/leases') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }));
          return;
        }
        if (!cleanupService || config.AUTONOMOUS_PUSH_MODE !== 'OIDC') {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Cleanup intake is disabled' }));
          return;
        }
        if (!isReady()) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'Worker is not ready' }));
          return;
        }

        const verifier =
          options.oidcTokenVerifier ?? new GoogleOidcTokenVerifier(undefined, logger);
        let authResult;
        try {
          authResult = await withTimeout(
            verifier.verifyToken(req.headers.authorization, {
              expectedAudience: config.PUBSUB_OIDC_AUDIENCE!,
              expectedServiceAccount: config.CLEANUP_OIDC_SERVICE_ACCOUNT!,
            }),
            config.OIDC_VERIFICATION_TIMEOUT_MS,
            'OIDC verification timeout exceeded',
          );
        } catch {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: 'OIDC_UNAVAILABLE',
              message: 'Identity verification unavailable; retry required',
            }),
          );
          return;
        }
        if (
          !authResult.valid ||
          authResult.audience !== config.PUBSUB_OIDC_AUDIENCE ||
          authResult.email !== config.CLEANUP_OIDC_SERVICE_ACCOUNT
        ) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Invalid cleanup identity' }));
          return;
        }

        try {
          const result = await cleanupService.sweepExpiredLeases();
          res.writeHead(result.status === 'COMPLETED' ? 200 : 503);
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: 'CLEANUP_UNAVAILABLE',
              message: 'Cleanup sweep failed; retry required',
            }),
          );
        }
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }));
        return;
      }

      // Minimal liveness endpoint
      if (urlPath === '/health' || urlPath === '/healthz') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      // Dependency-backed readiness endpoint
      if (urlPath === '/ready' || urlPath === '/readyz') {
        if (!isReady()) {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: 'SERVICE_UNAVAILABLE',
              message: isStopping ? 'Worker is shutting down' : 'Worker is not ready',
            }),
          );
          return;
        }

        const healthy = await repository.checkHealth().catch(() => false);
        if (!healthy || !isReady()) {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: 'SERVICE_UNAVAILABLE',
              message: 'Database connection failed',
            }),
          );
          return;
        }

        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: 'ready',
            database: 'connected',
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Route not found' }));
    });

    await new Promise<http.Server>((resolve, reject) => {
      healthServer!.listen(config.PORT, '0.0.0.0', () => resolve(healthServer!));
      healthServer!.once('error', reject);
    });

    healthServer.on('connection', (socket: Socket) => {
      trackedSockets.add(socket);
      socket.once('close', () => trackedSockets.delete(socket));
    });

    orchestrator.start();
    isReadyState = true;
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      'FalseRoute worker service initialized, polling, and listening for health checks',
    );

    let shutdownPromise: Promise<void> | null = null;

    const stop = async (reason = 'manual'): Promise<void> => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        isStopping = true;
        isReadyState = false;

        const totalTimeoutMs = config.WORKER_SHUTDOWN_TIMEOUT_MS ?? 8000;
        const drainTimeoutMs = config.WORKER_DRAIN_TIMEOUT_MS ?? 5000;
        const dbTimeoutMs = config.WORKER_DB_DISCONNECT_TIMEOUT_MS ?? 2000;
        const telemetryTimeoutMs = config.WORKER_TELEMETRY_TIMEOUT_MS ?? 1000;

        logger.info(
          { reason, totalTimeoutMs, drainTimeoutMs, dbTimeoutMs, telemetryTimeoutMs },
          'Worker shutdown initiated; stopping polling loop and health server',
        );

        const shutdownTask = (async () => {
          // Phase 1: Drain in-flight claims and close health server within drain budget
          try {
            const drainPromises: Promise<void>[] = [];

            if (healthServer) {
              const currentServer = healthServer;
              drainPromises.push(
                new Promise<void>((resolve) => {
                  currentServer.close(() => resolve());
                }),
              );
            }

            if (orchestrator) {
              drainPromises.push(orchestrator.stop());
            }

            await withTimeout(
              Promise.all(drainPromises),
              drainTimeoutMs,
              'Worker drain timeout exceeded',
            );
          } catch (drainErr) {
            const errorType =
              drainErr instanceof Error ? drainErr.constructor.name : 'UnknownError';
            logger.warn(
              { errorType, drainTimeoutMs },
              'Worker active claim or health server drain reached sub-deadline; active claims left uncompleted for lease recovery',
            );
            for (const socket of trackedSockets) {
              socket.destroy();
            }
          }

          // Phase 2: Disconnect database within DB timeout sub-budget
          if (db) {
            try {
              await withTimeout(
                db.$disconnect(),
                dbTimeoutMs,
                'Database disconnect timeout exceeded during worker shutdown',
              );
            } catch (dbErr) {
              const errorType = dbErr instanceof Error ? dbErr.constructor.name : 'UnknownError';
              logger.error({ errorType }, 'Error disconnecting database during worker shutdown');
            }
          }

          // Phase 3: Flush telemetry within telemetry timeout sub-budget
          try {
            await withTimeout(
              telemetry.shutdown(),
              telemetryTimeoutMs,
              'Telemetry shutdown timeout exceeded during worker shutdown',
            );
          } catch (telErr) {
            const errorType = telErr instanceof Error ? telErr.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Error shutting down telemetry during worker shutdown');
          }
        })();

        try {
          await withTimeout(shutdownTask, totalTimeoutMs, 'Total worker shutdown budget exceeded');
        } catch (totalErr) {
          const errorType = totalErr instanceof Error ? totalErr.constructor.name : 'UnknownError';
          logger.error({ errorType }, 'Worker shutdown exceeded total platform budget');
        }

        logger.info('FalseRoute worker service shutdown completed');
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
      healthServer,
      pushHandler,
      cleanupService,
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

    if (orchestrator) await orchestrator.stop().catch(() => {});
    if (healthServer) healthServer.close();
    if (db) await db.$disconnect().catch(() => {});
    await telemetry.shutdown().catch(() => {});

    throw startupErr;
  }
}
