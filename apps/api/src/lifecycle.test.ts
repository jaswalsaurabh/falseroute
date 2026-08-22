import { describe, expect, it, vi } from 'vitest';
import { type DatabaseClient } from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { startApiServer } from './lifecycle.js';
import { type ApiRepository } from './persistence/api-repository.js';

const syntheticToken = 'not-a-real-test-token-123456';

function createMockRepository(healthy = true): ApiRepository {
  return {
    createIntrusionEvent: vi.fn(),
    getIntrusionEvent: vi.fn(),
    listIntrusionEvents: vi.fn(),
    getDeceptionDecision: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue(healthy),
  } as unknown as ApiRepository;
}

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

describe('API Server Lifecycle', () => {
  it('initializes telemetry, creates app, and starts listening on configured port', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const instance = await startApiServer({
      env: {
        PORT: '0', // OS assigned port
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '500',
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

      const address = instance.server.address();
      expect(address).toBeDefined();
      expect(typeof address === 'object' && address !== null ? address.port : 0).toBeGreaterThan(0);
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('fails fast and does not open a listener if initialization throws', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();
    mockTelemetry.init = vi.fn().mockRejectedValue(new Error('Telemetry initialization failed'));

    await expect(
      startApiServer({
        env: {
          PORT: '0',
          DATABASE_URL:
            'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
          OPERATOR_ACCESS_TOKEN: syntheticToken,
          NODE_ENV: 'test',
        },
        db: mockDb,
        logger: mockLogger,
        telemetry: mockTelemetry,
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow('Telemetry initialization failed');

    expect(mockDb.$disconnect).toHaveBeenCalled();
  });

  it('marks service unready immediately when shutdown starts', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '1000',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Check readiness initially returns 200
    const initialRes = await fetch(`http://127.0.0.1:${port}/api/v1/ready`, {
      headers: { Authorization: `Bearer ${syntheticToken}` },
    });
    expect(initialRes.status).toBe(200);

    // Trigger stop in background
    const stopPromise = instance.stop('sigterm-test');
    expect(instance.isReady()).toBe(false);

    await stopPromise;
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent shutdown calls and executes teardown once', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '500',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const [res1, res2, res3] = await Promise.all([
      instance.stop('signal-1'),
      instance.stop('signal-2'),
      instance.stop('signal-3'),
    ]);

    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
    expect(res3).toBeUndefined();
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('forcefully terminates hanging socket connections after drain deadline', async () => {
    const net = await import('node:net');
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '200', // Very short timeout for testing
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Open a persistent TCP socket that stays open indefinitely
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {}); // swallow connection reset on destroy

    await new Promise<void>((resolve) => {
      socket.once('connect', () => resolve());
    });

    const startTime = Date.now();
    await instance.stop('timeout-test');
    const elapsed = Date.now() - startTime;

    // Shutdown should wait for the deadline before forcing socket destruction
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });
});
