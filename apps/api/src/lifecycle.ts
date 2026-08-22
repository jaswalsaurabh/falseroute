import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';
import {
  ActivityEventRepository,
  createDatabaseClient,
  PrismaClient,
  type DatabaseClient,
} from '@false-route/database';
import {
  createLogger,
  createTelemetry,
  type Logger,
  type TelemetryHandle,
} from '@false-route/observability';
import { parseApiConfig, type ApiConfig } from './config/api-config.js';
import { createApp } from './app.js';
import type { ApiRepository } from './persistence/api-repository.js';
import { ActivityStreamService } from './services/activity-stream-service.js';

export interface StartApiServerOptions {
  readonly config?: ApiConfig | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly db?: DatabaseClient | undefined;
  readonly logger?: Logger | undefined;
  readonly telemetry?: TelemetryHandle | undefined;
  readonly repository?: ApiRepository | undefined;
  readonly activityRepo?: ActivityEventRepository | undefined;
  readonly streamService?: ActivityStreamService | undefined;
  readonly registerSignalHandlers?: boolean | undefined;
  readonly onShutdownComplete?: ((exitCode: number) => void) | undefined;
}

export interface ApiServerInstance {
  readonly config: ApiConfig;
  readonly app: Express;
  readonly server: Server;
  readonly db: DatabaseClient;
  readonly telemetry: TelemetryHandle;
  readonly logger: Logger;
  readonly streamService: ActivityStreamService;
  readonly isReady: () => boolean;
  readonly stop: (reason?: string) => Promise<void>;
}

/**
 * Helper to run a task with an explicit timeout.
 */
async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Starts the FalseRoute API server with full runtime lifecycle management,
 * discrete readiness state, connection tracking, and bounded graceful draining.
 */
export async function startApiServer(
  options: StartApiServerOptions = {},
): Promise<ApiServerInstance> {
  const config = options.config ?? parseApiConfig(options.env ?? process.env);

  const logger =
    options.logger ??
    createLogger({
      serviceName: 'falseroute-api',
      environment: config.NODE_ENV,
      level: config.LOG_LEVEL,
    });

  const telemetry =
    options.telemetry ??
    createTelemetry({
      serviceName: 'falseroute-api',
      environment: config.NODE_ENV,
      enabled: config.ENABLE_TELEMETRY,
    });

  let isReadyState = false;
  const isReady = (): boolean => isReadyState;

  let db: DatabaseClient | null = null;
  let server: Server | null = null;
  let streamService: ActivityStreamService | null = null;
  const trackedSockets = new Set<Socket>();

  try {
    db = options.db ?? createDatabaseClient({ connectionString: config.DATABASE_URL });
    await telemetry.init();

    const activityRepo = options.activityRepo ?? new ActivityEventRepository(db as PrismaClient);
    streamService = options.streamService ?? new ActivityStreamService(activityRepo);

    const app = createApp({
      config,
      db,
      logger,
      activityRepo,
      streamService,
      ...(options.repository !== undefined ? { repository: options.repository } : {}),
      isReady,
    });

    // Start listening only after initialization succeeds
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(config.PORT, '0.0.0.0', () => resolve(s));
      s.once('error', reject);
    });

    isReadyState = true;
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'FalseRoute API server listening');

    // Track active sockets for bounded draining
    server.on('connection', (socket: Socket) => {
      trackedSockets.add(socket);
      socket.once('close', () => trackedSockets.delete(socket));
    });

    let shutdownPromise: Promise<void> | null = null;

    const stop = async (reason = 'manual'): Promise<void> => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        // 1. Immediately mark the process unready to fail incoming readiness probes
        isReadyState = false;

        const totalTimeoutMs = config.SHUTDOWN_TIMEOUT_MS ?? 8000;
        const drainTimeoutMs = config.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 5000;
        const dbTimeoutMs = config.SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS ?? 2000;
        const telemetryTimeoutMs = config.SHUTDOWN_TELEMETRY_TIMEOUT_MS ?? 1000;

        logger.info(
          { reason, totalTimeoutMs, drainTimeoutMs, dbTimeoutMs, telemetryTimeoutMs },
          'API server draining connections and initiating graceful shutdown',
        );

        const shutdownTask = (async () => {
          // Phase 1: Stop accepting new HTTP connections, close SSE streams, and drain active sockets within drain sub-budget
          if (streamService) {
            try {
              streamService.closeAll();
            } catch (streamErr) {
              const errorType =
                streamErr instanceof Error ? streamErr.constructor.name : 'UnknownError';
              logger.warn(
                { errorType },
                'Error closing activity stream service during API shutdown',
              );
            }
          }

          if (server) {
            const currentServer = server;
            const drainPromise = new Promise<void>((resolve) => {
              currentServer.close(() => resolve());
            });

            try {
              await withTimeout(
                drainPromise,
                drainTimeoutMs,
                'API server graceful drain timeout exceeded',
              );
            } catch (drainErr) {
              const errorType =
                drainErr instanceof Error ? drainErr.constructor.name : 'UnknownError';
              logger.warn(
                { openSockets: trackedSockets.size, errorType, drainTimeoutMs },
                'Graceful drain timeout exceeded; forcefully destroying remaining sockets',
              );
              for (const socket of trackedSockets) {
                socket.destroy();
              }
            }
          }

          // Phase 2: Disconnect PostgreSQL within DB sub-budget
          if (db) {
            try {
              await withTimeout(
                db.$disconnect(),
                dbTimeoutMs,
                'Database disconnect timeout exceeded during API shutdown',
              );
            } catch (dbErr) {
              const errorType = dbErr instanceof Error ? dbErr.constructor.name : 'UnknownError';
              logger.error({ errorType }, 'Error disconnecting database during API shutdown');
            }
          }

          // Phase 3: Flush telemetry within telemetry sub-budget
          try {
            await withTimeout(
              telemetry.shutdown(),
              telemetryTimeoutMs,
              'Telemetry shutdown timeout exceeded during API shutdown',
            );
          } catch (telErr) {
            const errorType = telErr instanceof Error ? telErr.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Error shutting down telemetry during API shutdown');
          }
        })();

        try {
          await withTimeout(
            shutdownTask,
            totalTimeoutMs,
            'Total API shutdown platform budget exceeded',
          );
        } catch (totalErr) {
          const errorType = totalErr instanceof Error ? totalErr.constructor.name : 'UnknownError';
          logger.error({ errorType }, 'API shutdown exceeded total platform budget');
        }

        logger.info('FalseRoute API server shutdown completed');
      })();

      return shutdownPromise;
    };

    const instance: ApiServerInstance = {
      config,
      app,
      server,
      db,
      telemetry,
      logger,
      streamService: streamService!,
      isReady,
      stop,
    };

    if (options.registerSignalHandlers) {
      let isSignalHandled = false;
      const handleSignal = (signal: string) => {
        if (isSignalHandled) return;
        isSignalHandled = true;
        logger.info({ signal }, 'API shutdown signal received');
        stop(signal).then(
          () => {
            if (options.onShutdownComplete) options.onShutdownComplete(0);
            else process.exit(0);
          },
          (err) => {
            const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Fatal error during API shutdown');
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
    logger.error({ errorType }, 'Fatal API startup error; aborting without listener');

    if (streamService) {
      try {
        streamService.closeAll();
      } catch {
        // Suppress secondary stream service close errors during startup abort
      }
    }
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // Suppress secondary disconnect errors during startup abort
      }
    }
    try {
      await telemetry.shutdown();
    } catch {
      // Suppress secondary telemetry errors during startup abort
    }

    throw startupErr;
  }
}
