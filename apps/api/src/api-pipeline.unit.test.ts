import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { type DatabaseClient } from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { ApiErrorResponseSchema } from '@false-route/contracts';
import { createApp } from './app.js';
import { type ApiRepository } from './persistence/api-repository.js';

const mockConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:5432/dummy_dev',
  OPERATOR_ACCESS_TOKEN: 'not-a-real-test-operator-token-pipeline',
  CORS_ORIGINS: 'http://localhost:5173,https://example.com',
  ENABLE_TELEMETRY: false,
  TRUST_PROXY_HOPS: 1,
};

const mockLogger = createLogger({
  serviceName: 'test-api-pipeline',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

const mockDb = {} as DatabaseClient;

function createCountingRepository(): ApiRepository & {
  counts: { createEvent: number; checkHealth: number };
} {
  const counts = { createEvent: 0, checkHealth: 0 };
  return {
    counts,
    async createEvent() {
      counts.createEvent += 1;
      return {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        occurredAt: '2026-08-22T00:00:00.000Z',
        receivedAt: '2026-08-22T00:00:01.000Z',
        correlationId: 'corr-pipeline-001',
        sourceIp: '192.168.1.1',
        targetAsset: 'mock-admin-portal',
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        failedLoginCount: 3,
        riskIndicators: ['SUSPICIOUS_UA'],
        containmentMode: 'SIMULATED',
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: 'PENDING',
        provenance: 'OBSERVED',
      };
    },
    async listEvents() {
      return { events: [], total: 0 };
    },
    async getEventById() {
      return null;
    },
    async getDecisionByEventId() {
      return null;
    },
    async checkHealth() {
      counts.checkHealth += 1;
      return true;
    },
  };
}

describe('API Pipeline Ordering & Preflight/Abuse Boundary', () => {
  const DEFAULT_BURST_CAPACITY = 30;

  function buildApp(clock?: () => number) {
    const repository = createCountingRepository();
    const app = createApp({
      config: mockConfig,
      db: mockDb,
      logger: mockLogger,
      repository,
      clock,
    });
    return { app, repository };
  }

  it('preflight OPTIONS requests receive CORS headers and 204 status', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .options('/api/v1/intrusion-events')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type,Authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('repeated OPTIONS preflight requests consume default quota and are eventually rejected with 429', async () => {
    let now = 1_000_000;
    const { app } = buildApp(() => now);

    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .options('/api/v1/intrusion-events')
        .set('Origin', 'http://localhost:5173')
        .set('X-Forwarded-For', '198.51.100.77');
      expect(res.status).toBe(204);
    }

    // 31st OPTIONS request must be rate limited by the default limiter
    const rejected = await request(app)
      .options('/api/v1/intrusion-events')
      .set('Origin', 'http://localhost:5173')
      .set('X-Forwarded-For', '198.51.100.77');

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(rejected.headers['retry-after']).toBeDefined();
  });

  it('malformed JSON requests consume default quota and are eventually rejected with 429', async () => {
    let now = 1_000_000;
    const { app } = buildApp(() => now);

    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .post('/api/v1/intrusion-events')
        .set('X-Forwarded-For', '198.51.100.88')
        .set('Content-Type', 'application/json')
        .send('{"invalidJson": unquoted}');
      // Malformed JSON reaches parser and returns 400
      expect(res.status).toBe(400);
    }

    // 31st malformed JSON request is stopped by default quota before reaching body parser
    const rejected = await request(app)
      .post('/api/v1/intrusion-events')
      .set('X-Forwarded-For', '198.51.100.88')
      .set('Content-Type', 'application/json')
      .send('{"invalidJson": unquoted}');

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
  });

  it('requests rejected by rate limiting never reach controller or repository methods', async () => {
    let now = 1_000_000;
    const { app, repository } = buildApp(() => now);

    // Exhaust default quota with unauthenticated calls
    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      await request(app).get('/api/v1/health').set('X-Forwarded-For', '198.51.100.99');
    }
    const initialHealthCount = repository.counts.checkHealth;

    // 31st request is blocked at rate limiter and never touches health controller/repo
    const blocked = await request(app)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '198.51.100.99');

    expect(blocked.status).toBe(429);
    expect(repository.counts.checkHealth).toBe(initialHealthCount);
  });

  it('preserves correlation ID and standard error contract on rate limit rejection', async () => {
    let now = 1_000_000;
    const { app } = buildApp(() => now);
    const correlationId = 'corr-pipeline-rejection-test-01';

    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      await request(app).get('/api/v1/health').set('X-Forwarded-For', '198.51.100.123');
    }

    const res = await request(app)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '198.51.100.123')
      .set('X-Correlation-Id', correlationId);

    expect(res.status).toBe(429);
    expect(res.headers['x-correlation-id']).toBe(correlationId);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(parsed.correlationId).toBe(correlationId);
  });
});
