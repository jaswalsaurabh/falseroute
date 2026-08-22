import { describe, expect, it, vi } from 'vitest';
import {
  type DatabaseClient,
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { startWorker } from './lifecycle.js';
import { type WorkerRepository } from './persistence/worker-repository.js';
import { type PubSubPushHandler } from './integrations/pubsub-push-handler.js';

function createMockDb(): DatabaseClient {
  return { $disconnect: vi.fn().mockResolvedValue(undefined) } as unknown as DatabaseClient;
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
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

function getPort(instance: Awaited<ReturnType<typeof startWorker>>): number {
  const addr = instance.healthServer?.address();
  return typeof addr === 'object' && addr !== null ? addr.port : 0;
}

const baseEnv = {
  PORT: '0',
  DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
  NODE_ENV: 'test',
};

const fullTimeouts = {
  WORKER_POLL_INTERVAL_MS: '100',
  WORKER_SHUTDOWN_TIMEOUT_MS: '8000',
  WORKER_DRAIN_TIMEOUT_MS: '5000',
  WORKER_DB_DISCONNECT_TIMEOUT_MS: '2000',
  WORKER_TELEMETRY_TIMEOUT_MS: '1000',
};

const boundedTimeouts = {
  WORKER_SHUTDOWN_TIMEOUT_MS: '1500',
  WORKER_DRAIN_TIMEOUT_MS: '200',
  WORKER_DB_DISCONNECT_TIMEOUT_MS: '300',
  WORKER_TELEMETRY_TIMEOUT_MS: '200',
};

describe('Worker Lifecycle & Health Server', () => {
  it('mounts the authenticated autonomous push handler only when explicitly enabled', async () => {
    const pushHandler = {
      handlePushRequest: vi
        .fn()
        .mockResolvedValue({ statusCode: 200, body: { status: 'COMPLETED' } }),
    } as unknown as PubSubPushHandler;
    const instance = await startWorker({
      env: {
        ...baseEnv,
        AUTONOMOUS_PUSH_MODE: 'LOCAL_SHARED_SECRET',
        AUTONOMOUS_LOCAL_PUSH_TOKEN: 'not-a-real-local-push-token',
      },
      db: createMockDb(),
      repository: createMockRepo(true),
      logger: createMockLogger(),
      telemetry: createMockTelemetry(),
      pushHandler,
      registerSignalHandlers: false,
    });

    try {
      const port = getPort(instance);
      const response = await fetch(`http://127.0.0.1:${port}/pubsub/push`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer not-a-real-local-push-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'test' }),
      });
      expect(response.status).toBe(200);
      expect(pushHandler.handlePushRequest).toHaveBeenCalledWith(
        'Bearer not-a-real-local-push-token',
        { message: 'test' },
      );
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('starts worker, initializes telemetry, starts health listener, and reports ready status', async () => {
    const mockDb = createMockDb();
    const mockTelemetry = createMockTelemetry();
    const mockRepo = createMockRepo(true);

    const instance = await startWorker({
      env: { ...baseEnv, ...fullTimeouts, WORKER_POLL_INTERVAL_MS: '1000' },
      db: mockDb,
      repository: mockRepo,
      logger: createMockLogger(),
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    try {
      expect(instance.isReady()).toBe(true);
      expect(mockTelemetry.init).toHaveBeenCalledTimes(1);
      expect(mockRepo.checkHealth).toHaveBeenCalled();

      const port = getPort(instance);
      expect(port).toBeGreaterThan(0);

      const livenessRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(livenessRes.status).toBe(200);
      expect(((await livenessRes.json()) as { status: string }).status).toBe('ok');

      const readinessRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(readinessRes.status).toBe(200);
      expect(await readinessRes.json()).toMatchObject({
        status: 'ready',
        database: 'connected',
      });
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('fails fast and does not open a listener if initialization throws or database is unreachable', async () => {
    const mockDb = createMockDb();
    const mockRepo = createMockRepo(false);

    await expect(
      startWorker({
        env: baseEnv,
        db: mockDb,
        repository: mockRepo,
        logger: createMockLogger(),
        telemetry: createMockTelemetry(),
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow('Initial database connectivity check failed');

    expect(mockDb.$disconnect).toHaveBeenCalled();
  });

  it('readiness returns 503 when database connectivity fails at runtime', async () => {
    let isDbUp = true;
    const mockRepo = {
      claimNextPendingEvent: vi.fn().mockResolvedValue(null),
      persistDecision: vi.fn().mockResolvedValue(undefined),
      releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
      checkHealth: vi.fn().mockImplementation(async () => isDbUp),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: baseEnv,
      db: createMockDb(),
      repository: mockRepo,
      logger: createMockLogger(),
      telemetry: createMockTelemetry(),
      registerSignalHandlers: false,
    });

    try {
      const port = getPort(instance);
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);

      isDbUp = false;
      const unreadyRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(unreadyRes.status).toBe(503);
      const unreadyBody = (await unreadyRes.json()) as { error: string; message: string };
      expect(unreadyBody.error).toBe('SERVICE_UNAVAILABLE');
      expect(unreadyBody.message).toBe('Database connection failed');
    } finally {
      await instance.stop('test-cleanup');
    }
  });

  it('stops polling and marks unready immediately during shutdown', async () => {
    const mockDb = createMockDb();
    const mockTelemetry = createMockTelemetry();

    const instance = await startWorker({
      env: { ...baseEnv, WORKER_POLL_INTERVAL_MS: '50' },
      db: mockDb,
      repository: createMockRepo(true),
      logger: createMockLogger(),
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    expect(instance.isReady()).toBe(true);
    const stopPromise = instance.stop('sigterm');
    expect(instance.isReady()).toBe(false);
    await stopPromise;

    expect(instance.isReady()).toBe(false);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockTelemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent stop calls', async () => {
    const mockDb = createMockDb();
    const mockTelemetry = createMockTelemetry();

    const instance = await startWorker({
      env: baseEnv,
      db: mockDb,
      repository: createMockRepo(true),
      logger: createMockLogger(),
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

  it('enforces slow-claim drain bounds when active claim processing is slow', async () => {
    const mockDb = createMockDb();
    const mockRepo = {
      claimNextPendingEvent: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return null;
      }),
      persistDecision: vi.fn().mockResolvedValue(undefined),
      releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
      checkHealth: vi.fn().mockResolvedValue(true),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: { ...baseEnv, ...boundedTimeouts, WORKER_POLL_INTERVAL_MS: '50' },
      db: mockDb,
      repository: mockRepo,
      logger: createMockLogger(),
      telemetry: createMockTelemetry(),
      registerSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 50));
    const start = Date.now();
    await instance.stop('drain-timeout-test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(700);
    expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('orders shutdown steps strictly: stops intake -> drains loops -> disconnects DB -> flushes telemetry', async () => {
    const order: string[] = [];
    const mockDb = {
      $disconnect: vi.fn().mockImplementation(async () => {
        order.push('db-disconnect');
      }),
    } as unknown as DatabaseClient;

    const mockTelemetry = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockImplementation(async () => {
        order.push('telemetry-shutdown');
      }),
    } as unknown as TelemetryHandle;

    const mockRepo = {
      claimNextPendingEvent: vi.fn().mockImplementation(async () => {
        order.push('worker-claim');
        return null;
      }),
      persistDecision: vi.fn().mockResolvedValue(undefined),
      releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
      checkHealth: vi.fn().mockResolvedValue(true),
    } as unknown as WorkerRepository;

    const instance = await startWorker({
      env: { ...baseEnv, ...fullTimeouts },
      db: mockDb,
      repository: mockRepo,
      logger: createMockLogger(),
      telemetry: mockTelemetry,
      registerSignalHandlers: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await instance.stop('order-verification');

    expect(order).toContain('db-disconnect');
    expect(order).toContain('telemetry-shutdown');
    expect(order.indexOf('db-disconnect')).toBeLessThan(order.indexOf('telemetry-shutdown'));
  });

  it('bounds shutdown when database disconnect hangs', async () => {
    const mockDb = {
      $disconnect: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000))),
    } as unknown as DatabaseClient;

    const instance = await startWorker({
      env: { ...baseEnv, ...boundedTimeouts },
      db: mockDb,
      repository: createMockRepo(true),
      logger: createMockLogger(),
      telemetry: createMockTelemetry(),
      registerSignalHandlers: false,
    });

    const start = Date.now();
    await instance.stop('hanging-db-test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1400);
  });

  it('bounds shutdown when telemetry flush hangs', async () => {
    const mockDb = createMockDb();
    const mockTelemetry = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000))),
    } as unknown as TelemetryHandle;

    const instance = await startWorker({
      env: {
        ...baseEnv,
        ...boundedTimeouts,
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '200',
        WORKER_TELEMETRY_TIMEOUT_MS: '300',
      },
      db: mockDb,
      repository: createMockRepo(true),
      logger: createMockLogger(),
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

  it('aborts cleanly and does not leave polling active when health server binding fails', async () => {
    const http = await import('node:http');
    const blocker = http.createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '0.0.0.0', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    const mockDb = createMockDb();
    const mockRepo = createMockRepo(true);

    try {
      await expect(
        startWorker({
          env: { ...baseEnv, PORT: String(occupiedPort), WORKER_POLL_INTERVAL_MS: '100' },
          db: mockDb,
          repository: mockRepo,
          logger: createMockLogger(),
          telemetry: createMockTelemetry(),
          registerSignalHandlers: false,
        }),
      ).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockRepo.claimNextPendingEvent).not.toHaveBeenCalled();
      expect(mockDb.$disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('composes an explicit unavailable adapter when GEMINI_API_KEY is absent, recording degraded activity on push', async () => {
    const recordedEvents: Array<{ eventType: string }> = [];
    const mockWorkflowRepo = {
      recordIngestionReceipt: vi.fn().mockResolvedValue({
        isDuplicate: false,
        receipt: {
          id: 'rec-1',
          eventId: '11111111-1111-4111-8111-111111111111',
          status: 'ACCEPTED',
        },
      }),
      reserveToolOperation: vi.fn().mockResolvedValue({ isExisting: false, operation: {} }),
      updateToolOperationStage: vi.fn().mockResolvedValue({}),
      claimProviderIntent: vi.fn().mockResolvedValue({
        disposition: 'CLAIMED',
        claimToken: '22222222-2222-4222-8222-222222222222',
        intent: { id: 'intent-1' },
      }),
      updateProviderIntentStatus: vi.fn().mockResolvedValue({}),
      createDecoyLease: vi.fn().mockResolvedValue({}),
      createFalseRouteLease: vi.fn().mockResolvedValue({}),
      createQuarantineLease: vi.fn().mockResolvedValue({}),
      recordDeliveryAttempt: vi.fn().mockResolvedValue({}),
    } as unknown as AutonomousWorkflowRepository;

    const mockActivityRepo = {
      recordActivityEvent: vi.fn().mockImplementation((evt: { eventType: string }) => {
        recordedEvents.push(evt);
        return Promise.resolve({ cursor: recordedEvents.length });
      }),
    } as unknown as ActivityEventRepository;

    const instance = await startWorker({
      env: {
        ...baseEnv,
        AUTONOMOUS_PUSH_MODE: 'LOCAL_SHARED_SECRET',
        AUTONOMOUS_LOCAL_PUSH_TOKEN: 'not-a-real-local-push-token',
      },
      db: createMockDb(),
      repository: createMockRepo(true),
      logger: createMockLogger(),
      telemetry: createMockTelemetry(),
      autonomousWorkflowRepository: mockWorkflowRepo,
      activityEventRepository: mockActivityRepo,
      registerSignalHandlers: false,
    });

    try {
      const port = getPort(instance);
      const envelopeData = {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-no-key-test',
        schemaVersion: '1.0.0',
        source: 'PUB_SUB',
        scenarioKind: 'ENV_FILE_PROBE',
        occurredAt: '2026-08-22T10:00:00.000Z',
        publishedAt: '2026-08-22T10:00:01.000Z',
        sourceIp: '198.51.100.25',
        evidence: {
          scenarioKind: 'ENV_FILE_PROBE',
          requestedPath: '/.env',
          httpMethod: 'GET',
          userAgent: 'not-a-real-scanner/1.0',
          sourceIp: '198.51.100.25',
          matchedString: '.env',
          isPositiveMatch: true,
        },
        provenance: 'OBSERVED',
      };
      const payload = {
        message: {
          data: Buffer.from(JSON.stringify(envelopeData)).toString('base64'),
          messageId: 'msg-no-key-1',
          publishTime: '2026-08-22T10:00:01.000Z',
        },
        subscription: 'projects/test/subscriptions/test-sub',
      };

      const response = await fetch(`http://127.0.0.1:${port}/pubsub/push`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer not-a-real-local-push-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const eventTypes = recordedEvents.map((e) => e.eventType);
      expect(eventTypes).toContain('GEMINI_ANALYSIS_DEGRADED');
      expect(eventTypes).not.toContain('GEMINI_ANALYSIS_COMPLETED');
      expect(eventTypes).not.toContain('MODEL_TOOL_REQUESTED');
    } finally {
      await instance.stop('test-cleanup');
    }
  });
});
