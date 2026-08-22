import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';
import { createDatabaseClient, type DatabaseClient } from '@false-route/database';
import {
  createLogger,
  createTelemetry,
  type Logger,
  type TelemetryHandle,
} from '@false-route/observability';
import { parseApiConfig, type ApiConfig } from './config/api-config.js';
import { createApp } from './app.js';
import type { ApiRepository } from './persistence/api-repository.js';

export interface StartApiServerOptions {
  readonly config?: ApiConfig | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly db?: DatabaseClient | undefined;
  readonly logger?: Logger | undefined;
  readonly telemetry?: TelemetryHandle | undefined;
  readonly repository?: ApiRepository | undefined;
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
  readonly isReady: () => boolean;
  readonly stop: (reason?: string) => Promise<void>;
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
  const trackedSockets = new Set<Socket>();

  try {
    db = options.db ?? createDatabaseClient({ connectionString: config.DATABASE_URL });
    await telemetry.init();

    const app = createApp({
      config,
      db,
      logger,
      ...(options.repository !== undefined ? { repository: options.repository } : {}),
      isReady,
    });

    // Start listening only after initialization succeeds
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(config.PORT, () => resolve(s));
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
        logger.info(
          { reason, timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
          'API server draining connections',
        );

        // 2. Stop accepting new HTTP connections
        if (server) {
          const currentServer = server;
          const drainPromise = new Promise<void>((resolve) => {
            currentServer.close(() => resolve());
          });

          // 3. Bound draining to SHUTDOWN_TIMEOUT_MS before forcing socket destruction
          let drainTimer: NodeJS.Timeout | null = null;
          const timeoutPromise = new Promise<void>((resolve) => {
            drainTimer = setTimeout(() => {
              logger.warn(
                { openSockets: trackedSockets.size, timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
                'Graceful drain timeout exceeded; forcefully destroying remaining sockets',
              );
              for (const socket of trackedSockets) {
                socket.destroy();
              }
              resolve();
            }, config.SHUTDOWN_TIMEOUT_MS);
          });

          await Promise.race([drainPromise, timeoutPromise]);
          if (drainTimer) clearTimeout(drainTimer);
        }

        // 4. Disconnect PostgreSQL and flush telemetry
        if (db) {
          try {
            await db.$disconnect();
          } catch (dbErr) {
            const errorType = dbErr instanceof Error ? dbErr.constructor.name : 'UnknownError';
            logger.error({ errorType }, 'Error disconnecting database during API shutdown');
          }
        }

        try {
          await telemetry.shutdown();
        } catch (telErr) {
          const errorType = telErr instanceof Error ? telErr.constructor.name : 'UnknownError';
          logger.error({ errorType }, 'Error shutting down telemetry during API shutdown');
        }

        logger.info('FalseRoute API server shutdown cleanly');
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
