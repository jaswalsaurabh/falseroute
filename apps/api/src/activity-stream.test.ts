import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { createApp } from './app.js';
import { type ApiConfig } from './config/api-config.js';
import { ActivityEventRepository, type DatabaseClient } from '@false-route/database';
import { type Logger } from '@false-route/observability';
import { type Response } from 'express';
import { ActivityStreamService } from './services/activity-stream-service.js';

describe('Activity Routes & SSE Streaming', () => {
  const mockConfig: ApiConfig = {
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
    PORT: 3000,
    DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5432/falseroute_test',
    OPERATOR_ACCESS_TOKEN: 'not-a-real-test-token-1234567890',
    CORS_ORIGINS: 'http://localhost:5173',
    ENABLE_TELEMETRY: false,
    TRUST_PROXY_HOPS: 0,
  };

  const mockDb = {
    activityEventRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn(),
  } as unknown as DatabaseClient;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  let streamService: ActivityStreamService;

  beforeEach(() => {
    streamService = new ActivityStreamService(undefined, { heartbeatIntervalMs: 60000 });
  });

  afterEach(() => {
    streamService.closeAll();
  });

  it('rejects unauthenticated requests to /api/v1/activity with 401', async () => {
    const app = createApp({
      config: mockConfig,
      db: mockDb,
      logger: mockLogger,
      streamService,
    });

    const res = await request(app).get('/api/v1/activity');
    expect(res.status).toBe(401);
  });

  it('returns activity snapshot with authenticated token', async () => {
    const app = createApp({
      config: mockConfig,
      db: mockDb,
      logger: mockLogger,
      streamService,
    });

    const res = await request(app)
      .get('/api/v1/activity')
      .set('Authorization', `Bearer ${mockConfig.OPERATOR_ACCESS_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.systemMode).toBe('LOCAL_FAKE');
    expect(res.body.latestCursor).toBe(0);
  });

  it('redacts nested sensitive keys recursively at all levels', () => {
    const nestedData = {
      level1: 'public',
      auth: {
        bearerToken: 'secret-token-12345',
        nestedArray: [{ secretKey: 'key-abc', normalVal: 42 }, { userPassword: 'password123' }],
      },
    };

    interface RedactedNestedData {
      level1: string;
      auth: {
        bearerToken: string;
        nestedArray: Array<{ secretKey?: string; normalVal?: number; userPassword?: string }>;
      };
    }

    const redacted = streamService.deepRedactSensitiveData(
      nestedData,
    ) as unknown as RedactedNestedData;
    expect(redacted.level1).toBe('public');
    expect(redacted.auth.bearerToken).toBe('[REDACTED]');
    expect(redacted.auth.nestedArray[0]?.secretKey).toBe('[REDACTED]');
    expect(redacted.auth.nestedArray[0]?.normalVal).toBe(42);
    expect(redacted.auth.nestedArray[1]?.userPassword).toBe('[REDACTED]');
  });

  it('connects to /api/v1/activity/stream with text/event-stream headers', async () => {
    const app = createApp({
      config: mockConfig,
      db: mockDb,
      logger: mockLogger,
      streamService,
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };

    const headersPromise = new Promise<{ statusCode: number; contentType: string }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/activity/stream',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${mockConfig.OPERATOR_ACCESS_TOKEN}`,
          },
        },
        (res) => {
          resolve({
            statusCode: res.statusCode ?? 0,
            contentType: String(res.headers['content-type']),
          });
          res.destroy();
        },
      );

      req.on('error', () => {
        // Expected when connection is closed
      });

      req.end();
    });

    const result = await headersPromise;
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toContain('text/event-stream');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('redacts sensitive snapshot payloads before returning API data', async () => {
    const repository = {
      getLatestCursor: vi.fn().mockResolvedValue(1),
      getLatestEvents: vi.fn().mockResolvedValue([
        {
          cursor: 1,
          id: 'activity-1',
          eventId: '11111111-1111-4111-8111-111111111111',
          correlationId: 'corr-redaction-1',
          stage: 'RECEIVED',
          eventType: 'INTRUSION_INGESTED',
          summary: 'Activity persisted',
          provenance: 'OBSERVED',
          payload: { nested: { authorizationToken: 'not-a-real-secret', safe: 'visible' } },
          occurredAt: new Date('2026-08-22T10:00:00.000Z'),
          createdAt: new Date('2026-08-22T10:00:00.000Z'),
        },
      ]),
      getTotalCount: vi.fn().mockResolvedValue(1),
    } as unknown as ActivityEventRepository;
    const service = new ActivityStreamService(repository, {
      heartbeatIntervalMs: 60000,
      pollIntervalMs: 60000,
    });

    const snapshot = await service.getSnapshot(undefined, 50);

    expect(snapshot.events[0]?.payload).toEqual({
      nested: { authorizationToken: '[REDACTED]', safe: 'visible' },
    });
    service.closeAll();
  });

  it('paginates catch-up to a captured cursor before making the client live', async () => {
    const records = Array.from({ length: 205 }, (_, index) => ({
      cursor: index + 1,
      id: `activity-${index + 1}`,
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-catch-up-1',
      stage: 'RECEIVED',
      eventType: 'INTRUSION_INGESTED',
      summary: `Activity ${index + 1}`,
      provenance: 'OBSERVED',
      occurredAt: new Date('2026-08-22T10:00:00.000Z'),
      createdAt: new Date('2026-08-22T10:00:00.000Z'),
    }));
    const repository = {
      getLatestCursor: vi.fn().mockResolvedValue(205),
      getEventsBetween: vi
        .fn()
        .mockImplementation((after: number, through: number, limit: number) =>
          Promise.resolve(
            records
              .filter((record) => record.cursor > after && record.cursor <= through)
              .slice(0, limit),
          ),
        ),
    } as unknown as ActivityEventRepository;
    const writes: string[] = [];
    const response = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn((payload: string) => {
        writes.push(payload);
        return true;
      }),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;
    const service = new ActivityStreamService(repository, {
      heartbeatIntervalMs: 60000,
      pollIntervalMs: 60000,
      pageSize: 100,
    });

    expect(await service.registerClient(response, 0)).toBe(true);
    expect(repository.getEventsBetween).toHaveBeenCalledTimes(3);
    expect(writes.some((payload) => payload.startsWith('id: 205\n'))).toBe(true);
    service.closeAll();
  });

  it('disconnects a slow client when write signals backpressure', async () => {
    const response = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn().mockReturnValue(false),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;
    expect(await streamService.registerClient(response)).toBe(false);
    expect(streamService.getActiveClientCount()).toBe(0);
    expect(response.end).toHaveBeenCalledOnce();
  });
  it('queues live events while finite catch-up is in progress', async () => {
    let releasePage!: (records: unknown[]) => void;
    const page = new Promise<unknown[]>((resolve) => {
      releasePage = resolve;
    });
    const repository = {
      getLatestCursor: vi.fn().mockResolvedValue(1),
      getEventsBetween: vi.fn().mockReturnValue(page),
    } as unknown as ActivityEventRepository;
    const writes: string[] = [];
    const response = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn((payload: string) => (writes.push(payload), true)),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;
    const service = new ActivityStreamService(repository, {
      heartbeatIntervalMs: 60000,
      pollIntervalMs: 60000,
    });
    const registration = service.registerClient(response, 0);
    await vi.waitFor(() => expect(repository.getEventsBetween).toHaveBeenCalled());
    const common = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-registration-race',
      stage: 'RECEIVED' as const,
      eventType: 'INTRUSION_INGESTED',
      provenance: 'OBSERVED' as const,
      occurredAt: '2026-08-22T10:00:00.000Z',
    };
    service.broadcast({ ...common, cursor: 2, summary: 'Live event' });
    releasePage([
      {
        ...common,
        id: 'activity-1',
        cursor: 1,
        summary: 'Catch-up event',
        occurredAt: new Date(common.occurredAt),
        createdAt: new Date(common.occurredAt),
      },
    ]);
    expect(await registration).toBe(true);
    expect(
      writes.filter((value) => value.startsWith('id: ')).map((value) => value.slice(4, 5)),
    ).toEqual(['1', '2']);
    service.closeAll();
  });

  it('rejects new connections with 503 when maxConnections ceiling is reached', async () => {
    const limitedService = new ActivityStreamService(undefined, { maxConnections: 1 });
    const client1 = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;
    const client2 = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    expect(await limitedService.registerClient(client1)).toBe(true);
    expect(await limitedService.registerClient(client2)).toBe(false);
    expect(client2.status).toHaveBeenCalledWith(503);
    limitedService.closeAll();
  });

  it('filters out events with cursors less than or equal to client cursor', async () => {
    const writes: string[] = [];
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn((payload: string) => (writes.push(payload), true)),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;

    // Start with Last-Event-ID = 5
    await streamService.registerClient(client, 5);

    const common = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-duplicate-cursor',
      stage: 'RECEIVED' as const,
      eventType: 'INTRUSION_INGESTED',
      provenance: 'OBSERVED' as const,
      occurredAt: '2026-08-22T10:00:00.000Z',
    };

    // Stale or duplicate events must be ignored
    streamService.broadcast({ ...common, cursor: 4, summary: 'Older event' });
    streamService.broadcast({ ...common, cursor: 5, summary: 'Exact duplicate cursor' });

    // Newer event must be written
    streamService.broadcast({ ...common, cursor: 6, summary: 'Newer event' });

    const activityWrites = writes.filter((w) => w.startsWith('id: '));
    expect(activityWrites).toHaveLength(1);
    expect(activityWrites[0]).toContain('id: 6');
  });

  it('emits stream_error and disconnects when catch-up query fails', async () => {
    const errorRepo = {
      getLatestCursor: vi.fn().mockRejectedValue(new Error('DB read failure')),
    } as unknown as ActivityEventRepository;
    const writes: string[] = [];
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn((payload: string) => (writes.push(payload), true)),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;

    const failingService = new ActivityStreamService(errorRepo);
    const result = await failingService.registerClient(client, 0);

    expect(result).toBe(false);
    expect(writes.some((w) => w.includes('CATCH_UP_FAILED'))).toBe(true);
    expect(client.end).toHaveBeenCalled();
    failingService.closeAll();
  });
});
