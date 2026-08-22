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

function createMockRepo(): WorkerRepository {
  return {
    claimNextPendingEvent: vi.fn().mockResolvedValue(null),
    persistDecision: vi.fn().mockResolvedValue(undefined),
    recordProcessingFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerRepository;
}

describe('Worker Lifecycle', () => {
  it('starts worker, initializes telemetry, and reports ready status', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo();

    const instance = await startWorker({
      env: {
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '1000',
        WORKER_SHUTDOWN_TIMEOUT_MS: '500',
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
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('aborts startup and cleans up if initialization throws', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    mockTelemetry.init = vi.fn().mockRejectedValue(new Error('Telemetry startup failure'));

    await expect(
      startWorker({
        env: {
          DATABASE_URL:
            'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
          NODE_ENV: 'test',
        },
        db: mockDb,
        logger: mockLogger,
        telemetry: mockTelemetry,
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow('Telemetry startup failure');

    expect(mockDb.$disconnect).toHaveBeenCalled();
  });

  it('stops polling and disconnects dependencies on stop', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo();

    const instance = await startWorker({
      env: {
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '50',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    expect(instance.isReady()).toBe(true);

    await instance.stop('sigterm');

    expect(instance.isReady()).toBe(false);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent stop calls', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo();

    const instance = await startWorker({
      env: {
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

    const [stop1, stop2] = await Promise.all([
      instance.stop('signal-a'),
      instance.stop('signal-b'),
    ]);

    expect(stop1).toBeUndefined();
    expect(stop2).toBeUndefined();
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('enforces shutdown timeout when active claim processing is slow', async () => {
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
      recordProcessingFailure: vi.fn(),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: {
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_SHUTDOWN_TIMEOUT_MS: '200', // Enforce 200ms timeout
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    // Let the worker start its slow step
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    await instance.stop('timeout-test');
    const elapsed = Date.now() - start;

    // Shutdown should finish around 200ms without waiting for full 1000ms
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(800);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });
});
