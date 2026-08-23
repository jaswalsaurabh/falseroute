import { describe, expect, it, vi } from 'vitest';
import { type DatabaseClient } from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { startApiServer } from './lifecycle.js';
import { type ApiRepository } from './persistence/api-repository.js';
import { type ActivityStreamService } from './services/activity-stream-service.js';

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
        SHUTDOWN_TIMEOUT_MS: '8000',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '5000',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '2000',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '1000',
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
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
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
        SHUTDOWN_TIMEOUT_MS: '3000',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '1000',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '1000',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '1000',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Check readiness returns 200 without Authorization header (Cloud Run probe compatibility)
    const initialRes = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
    expect(initialRes.status).toBe(200);

    // Trigger stop in background and check immediate unready state
    const stopPromise = instance.stop('sigterm-test');
    expect(instance.isReady()).toBe(false);

    await stopPromise;
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('readiness probe returns 503 when database is unavailable', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(false); // DB unhealthy
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('SERVICE_UNAVAILABLE');
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('readiness returns 503 if shutdown starts while database check is in flight', async () => {
    const mockDb = createMockDb();
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    let checkHealthResolver: ((val: boolean) => void) | null = null;
    const mockRepo = {
      createIntrusionEvent: vi.fn(),
      getIntrusionEvent: vi.fn(),
      listIntrusionEvents: vi.fn(),
      getDeceptionDecision: vi.fn(),
      checkHealth: vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            checkHealthResolver = resolve;
          }),
      ),
    } as unknown as ApiRepository;

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '1500',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '500',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '500',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '500',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Start probe request (hangs in checkHealth)
    const probePromise = fetch(`http://127.0.0.1:${port}/api/v1/ready`);

    // Give fetch time to enter checkHealth
    await new Promise((r) => setTimeout(r, 50));

    // Initiate shutdown while checkHealth is in-flight
    const stopPromise = instance.stop('in-flight-race-test');

    // Resolve the DB check as healthy
    if (checkHealthResolver) {
      (checkHealthResolver as (val: boolean) => void)(true);
    }

    const probeRes = await probePromise;
    expect(probeRes.status).toBe(503);
    const probeBody = (await probeRes.json()) as { error: string };
    expect(probeBody.error).toBe('SERVICE_UNAVAILABLE');

    await stopPromise;
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
        SHUTDOWN_TIMEOUT_MS: '1500',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '500',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '500',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '500',
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
        SHUTDOWN_TIMEOUT_MS: '1000',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '200', // 200ms drain timeout
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '300',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '300',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Open a persistent TCP socket and send an in-flight authenticated request waiting for body data
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {}); // swallow connection reset on destroy

    await new Promise<void>((resolve) => {
      socket.once('connect', () => {
        socket.write(
          `POST /api/v1/intrusion-events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${syntheticToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"partial":`,
        );
        resolve();
      });
    });

    // Give server a moment to receive headers and wait for body
    await new Promise((r) => setTimeout(r, 50));

    const startTime = Date.now();
    await instance.stop('timeout-test');
    const elapsed = Date.now() - startTime;

    // Shutdown should wait for the drain deadline (200ms) before forcing socket destruction
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
        SHUTDOWN_TIMEOUT_MS: '1500',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '200',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '300', // 300ms sub-budget
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '200',
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

    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1400);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when telemetry flush hangs', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
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

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
        SHUTDOWN_TIMEOUT_MS: '1500',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '200',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '200',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '300', // 300ms sub-budget
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

    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1400);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes activity stream service and stops polling before disconnecting database during shutdown', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepository(true);
    const mockLogger = createMockLogger();
    const mockTelemetry = createMockTelemetry();

    const mockStreamService = {
      closeAll: vi.fn(),
      getSnapshot: vi.fn().mockResolvedValue({
        events: [],
        latestCursor: 0,
        totalCount: 0,
        systemMode: 'LOCAL_FAKE',
      }),
      registerClient: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn(),
      getActiveClientCount: vi.fn().mockReturnValue(0),
      deepRedactSensitiveData: vi.fn((data) => data),
    };

    const instance = await startApiServer({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        OPERATOR_ACCESS_TOKEN: syntheticToken,
        NODE_ENV: 'test',
      },
      db: mockDb,
      repository: mockRepo,
      logger: mockLogger,
      telemetry: mockTelemetry,
      streamService: mockStreamService as unknown as ActivityStreamService,
      registerSignalHandlers: false,
    });

    await instance.stop('sse-shutdown-test');

    expect(mockStreamService.closeAll).toHaveBeenCalledTimes(1);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockStreamService.closeAll.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(mockDb.$disconnect).mock.invocationCallOrder[0]!,
    );
  });
});
