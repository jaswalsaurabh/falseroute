import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { type DatabaseClient } from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { ApiErrorResponseSchema, type IntrusionEvent } from '@false-route/contracts';
import { createApp } from './app.js';
import { type ApiRepository } from './persistence/api-repository.js';
import { getRequestClassBudget } from './config/rate-limits.js';

const mockConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://fake:fake@127.0.0.1:5432/fake',
  OPERATOR_ACCESS_TOKEN: 'test-secret-operator-token-12345',
  CORS_ORIGINS: 'http://localhost:5173',
  ENABLE_TELEMETRY: false,
  TRUST_PROXY_HOPS: 0,
};

const mockLogger = createLogger({
  serviceName: 'test-api',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

const mockDb = {} as DatabaseClient;
const authHeader = `Bearer ${mockConfig.OPERATOR_ACCESS_TOKEN}`;

const mockDecoyEvent: IntrusionEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-unit-001',
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

function createMockRepository(): ApiRepository {
  return {
    async createEvent() {
      return mockDecoyEvent;
    },
    async listEvents() {
      return { events: [mockDecoyEvent], total: 1 };
    },
    async getEventById(id: string) {
      return id === mockDecoyEvent.id ? { event: mockDecoyEvent, decision: null } : null;
    },
    async getDecisionByEventId(eventId: string) {
      return eventId === mockDecoyEvent.id ? null : null;
    },
    async checkHealth() {
      return true;
    },
  };
}

interface CountingApiRepository extends ApiRepository {
  counts: { createEvent: number };
}

function createCountingRepository(): CountingApiRepository {
  const base = createMockRepository();
  const counts = { createEvent: 0 };
  return {
    ...base,
    async createEvent(...args: Parameters<ApiRepository['createEvent']>) {
      counts.createEvent += 1;
      return base.createEvent(...args);
    },
    counts: counts,
  };
}

describe('Request-Class Budgets (process-local abuse controls)', () => {
  const writeBudget = getRequestClassBudget('write').maxRequests;
  const healthBudget = getRequestClassBudget('health').maxRequests;
  const abuseBudget = getRequestClassBudget('abuse').maxRequests;

  function buildApp(trustProxyHops = 0): {
    app: ReturnType<typeof createApp>;
    counts: { createEvent: number };
  } {
    const repository = createCountingRepository();
    const app = createApp({
      config: { ...mockConfig, TRUST_PROXY_HOPS: trustProxyHops },
      db: mockDb,
      logger: mockLogger,
      repository,
    });
    return {
      app,
      get counts() {
        return repository.counts;
      },
    };
  }

  function validCreatePayload() {
    const {
      status: _status,
      provenance: _prov,
      receivedAt: _rec,
      ...createPayload
    } = mockDecoyEvent;
    return createPayload;
  }

  it('rejects over-budget writes with 429 and never invokes the controller or repository', async () => {
    const { app, counts } = buildApp();

    for (let i = 0; i < writeBudget; i += 1) {
      const res = await request(app)
        .post('/api/v1/intrusion-events')
        .set('Authorization', authHeader)
        .send(validCreatePayload());
      expect(res.status).toBe(202);
    }
    expect(counts.createEvent).toBe(writeBudget);

    const rejected = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(validCreatePayload());

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(parsed.correlationId).toBeDefined();
    expect(Object.keys(rejected.body).toSorted()).toEqual(['correlationId', 'error', 'message']);
    expect(JSON.stringify(rejected.body).length).toBeLessThan(512);
    expect(parseInt(rejected.headers['retry-after'] as string, 10)).toBeGreaterThanOrEqual(1);
    expect(parseInt(rejected.headers['retry-after'] as string, 10)).toBeLessThanOrEqual(60);
    // The bearer token must never leak into rejection responses.
    expect(rejected.text).not.toContain(mockConfig.OPERATOR_ACCESS_TOKEN);

    expect(counts.createEvent).toBe(writeBudget);
  });

  it('keys authenticated traffic on the verified principal, ignoring source IP', async () => {
    const { app, counts } = buildApp(1);

    for (let i = 0; i < writeBudget; i += 1) {
      const res = await request(app)
        .post('/api/v1/intrusion-events')
        .set('Authorization', authHeader)
        .set('X-Forwarded-For', `198.51.100.${(i % 5) + 1}`)
        .send(validCreatePayload());
      expect(res.status).toBe(202);
    }
    expect(counts.createEvent).toBe(writeBudget);

    const rejected = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .set('X-Forwarded-For', '198.51.100.99')
      .send(validCreatePayload());

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(counts.createEvent).toBe(writeBudget);
  });

  it('ignores forwarding headers by default and isolates source IPs when proxy hops are trusted', async () => {
    const { app: closedApp } = buildApp(0);
    for (let i = 0; i < healthBudget; i += 1) {
      const ip = i % 2 === 0 ? '203.0.113.10' : '203.0.113.20';
      const res = await request(closedApp).get('/api/v1/health').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
    }
    const ignored = await request(closedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.10');
    expect(ignored.status).toBe(429);

    const { app: trustedApp } = buildApp(1);
    for (let i = 0; i < healthBudget; i += 1) {
      const res = await request(trustedApp)
        .get('/api/v1/health')
        .set('X-Forwarded-For', '203.0.113.10');
      expect(res.status).toBe(200);
    }
    const exhausted = await request(trustedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.10');
    expect(exhausted.status).toBe(429);

    const otherIp = await request(trustedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.11');
    expect(otherIp.status).toBe(200);
  });

  it('bounds repeated authentication failures per source address and isolates across addresses', async () => {
    const { app } = buildApp(1);

    for (let i = 0; i < abuseBudget; i += 1) {
      const res = await request(app).get('/api/v1/ready').set('X-Forwarded-For', '203.0.113.50');
      expect(res.status).toBe(401);
    }

    const throttled = await request(app)
      .get('/api/v1/ready')
      .set('X-Forwarded-For', '203.0.113.50');
    expect(throttled.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(throttled.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(parseInt(throttled.headers['retry-after'] as string, 10)).toBeGreaterThanOrEqual(1);
    expect(throttled.text).not.toContain(mockConfig.OPERATOR_ACCESS_TOKEN);

    const otherIp = await request(app).get('/api/v1/ready').set('X-Forwarded-For', '203.0.113.51');
    expect(otherIp.status).toBe(401);
  });
});
