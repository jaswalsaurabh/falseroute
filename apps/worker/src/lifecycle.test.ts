import { describe, expect, it, vi } from 'vitest';
import { type DatabaseClient } from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { startWorker } from './lifecycle.js';
import { type WorkerRepository } from './persistence/worker-repository.js';

function createMockDb(): DatabaseClient {
  return {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseClient;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createMockTelemetry(): TelemetryHandle {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelemetryHandle;
}

function createMockRepo(healthy = true): WorkerRepository {
  return {
    claimNextPendingEvent: vi.fn().mockResolvedValue(null),
    persistDecision: vi.fn().mockResolvedValue(undefined),
    releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
    checkHealth: vi.fn().mockResolvedValue(healthy),
  } as unknown as WorkerRepository;
}

describe('Worker Lifecycle & Health Server', () => {
  it('starts worker, initializes telemetry, starts health listener, and reports ready status', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '1000',
        WORKER_SHUTDOWN_TIMEOUT_MS: '8000',
        WORKER_DRAIN_TIMEOUT_MS: '5000',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '2000',
        WORKER_TELEMETRY_TIMEOUT_MS: '1000',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    try {
      expect(instance.isReady()).toBe(true);
      expect(mockTelemetry.init).toHaveBeenCalledTimes(1);
      expect(mockRepo.checkHealth).toHaveBeenCalled();

      const addr = instance.healthServer?.address();
      expect(addr).toBeDefined();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      // Verify liveness probe
      const livenessRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(livenessRes.status).toBe(200);
      const livenessBody = (await livenessRes.json()) as { status: string };
      expect(livenessBody.status).toBe('ok');

      // Verify readiness probe
      const readinessRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(readinessRes.status).toBe(200);
      const readinessBody = (await readinessRes.json()) as { status: string; database: string };
      expect(readinessBody.status).toBe('ready');
      expect(readinessBody.database).toBe('connected');
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('fails fast and does not open a listener if initialization throws or database is unreachable', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(false); // Unhealthy DB

    await expect(
      startWorker({
        env: {
          PORT: '0',
          DATABASE_URL:
            'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
          NODE_ENV: 'test',
        },
        db: mockDb,
        repository: mockRepo,
        logger: mockLogger,
        telemetry: mockTelemetry,
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow('Initial database connectivity check failed');

    expect(mockDb.$disconnect).toHaveBeenCalled();
  });

  it('readiness returns 503 when database connectivity fails at runtime', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    let isDbUp = true;
    const mockRepo = {
      claimNextPendingEvent: vi.fn().mockResolvedValue(null),
      persistDecision: vi.fn().mockResolvedValue(undefined),
      releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
      checkHealth: vi.fn().mockImplementation(async () => isDbUp),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '500',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.healthServer?.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    try {
      const initialRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(initialRes.status).toBe(200);

      // Simulate database dropping
      isDbUp = false;
      const failRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(failRes.status).toBe(503);
      const failBody = (await failRes.json()) as { error: string };
      expect(failBody.error).toBe('SERVICE_UNAVAILABLE');
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('marks service unready immediately when shutdown starts and closes health server', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '500',
        WORKER_SHUTDOWN_TIMEOUT_MS: '3000',
        WORKER_DRAIN_TIMEOUT_MS: '1000',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '1000',
        WORKER_TELEMETRY_TIMEOUT_MS: '1000',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const stopPromise = instance.stop('sigterm-test');
    expect(instance.isReady()).toBe(false);

    await stopPromise;
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent stop calls and executes teardown once', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const [stop1, stop2, stop3] = await Promise.all([
      instance.stop('signal-a'),
      instance.stop('signal-b'),
      instance.stop('signal-c'),
    ]);

    expect(stop1).toBeUndefined();
    expect(stop2).toBeUndefined();
    expect(stop3).toBeUndefined();
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('enforces drain sub-budget when claim processing is slow', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    // Mock slow claim that takes 1000ms
    const mockRepo = {
      claimNextPendingEvent: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return null;
      }),
      persistDecision: vi.fn(),
      releaseOrFailClaim: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_SHUTDOWN_TIMEOUT_MS: '1500',
        WORKER_DRAIN_TIMEOUT_MS: '200',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '500',
        WORKER_TELEMETRY_TIMEOUT_MS: '500',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    // Let the worker start its slow step
    await new Promise((r) => setTimeout(r, 60));

    const start = Date.now();
    await instance.stop('timeout-test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when database disconnect hangs', async () => {
    const mockDb = {
      $disconnect: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            // Hang indefinitely
            setTimeout(resolve, 10000);
          }),
      ),
    } as unknown as DatabaseClient;

    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_SHUTDOWN_TIMEOUT_MS: '1500',
        WORKER_DRAIN_TIMEOUT_MS: '200',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '300', // 300ms sub-budget
        WORKER_TELEMETRY_TIMEOUT_MS: '200',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const start = Date.now();
    await instance.stop('hanging-db-test');
    const elapsed = Date.now() - start;

    // Must not wait 10,000ms; should time out within sub-budget
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1400);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when telemetry flush hangs', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            // Hang indefinitely
            setTimeout(resolve, 10000);
          }),
      ),
    } as unknown as TelemetryHandle;
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_SHUTDOWN_TIMEOUT_MS: '1500',
        WORKER_DRAIN_TIMEOUT_MS: '200',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '200',
        WORKER_TELEMETRY_TIMEOUT_MS: '300', // 300ms sub-budget
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const start = Date.now();
    await instance.stop('hanging-telemetry-test');
    const elapsed = Date.now() - start;

    // Must not wait 10,000ms
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1400);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });
});
