import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { type DatabaseClient } from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { ApiErrorResponseSchema, type IntrusionEvent } from '@false-route/contracts';
import { createApp } from './app.js';
import { type ApiRepository } from './persistence/api-repository.js';

const mockConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://fake:fake@127.0.0.1:5432/fake',
  OPERATOR_ACCESS_TOKEN: 'not-a-real-test-operator-token-12345',
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
      return id === mockDecoyEvent.id
        ? { event: mockDecoyEvent, decision: null, simulatedEffect: null }
        : null;
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
  counts: { createEvent: number; checkHealth: number };
}

function createCountingRepository(): CountingApiRepository {
  const base = createMockRepository();
  const counts = { createEvent: 0, checkHealth: 0 };
  return {
    ...base,
    async createEvent(...args: Parameters<ApiRepository['createEvent']>) {
      counts.createEvent += 1;
      return base.createEvent(...args);
    },
    async checkHealth() {
      counts.checkHealth += 1;
      return base.checkHealth();
    },
    counts: counts,
  };
}

describe('Hierarchical Abuse Controls & Request Budgets', () => {
  // Approved provisional limits from IMPLEMENTATION_PLAN.md:
  // - Default API quota: 120 req/min with burst capacity 30
  // - Intrusion-event creation: 30 req/min with burst capacity 10
  // - Public liveness: 60 req/min with burst capacity 10
  // - Pre-auth abuse: 20 failures/min with burst capacity 20
  const WRITE_BURST_CAPACITY = 10;
  const HEALTH_BURST_CAPACITY = 10;
  const DEFAULT_BURST_CAPACITY = 30;
  const ABUSE_BURST_CAPACITY = 20;

  function buildApp(
    trustProxyHops = 0,
    clock?: () => number,
  ): {
    app: ReturnType<typeof createApp>;
    counts: { createEvent: number; checkHealth: number };
  } {
    const repository = createCountingRepository();
    const app = createApp({
      config: { ...mockConfig, TRUST_PROXY_HOPS: trustProxyHops },
      db: mockDb,
      logger: mockLogger,
      repository,
      clock,
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

  it('rejects over-budget writes with 429 after consuming burst capacity (10) and never invokes repository', async () => {
    let now = 1_000_000;
    const { app, counts } = buildApp(1, () => now);

    for (let i = 0; i < WRITE_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .post('/api/v1/intrusion-events')
        .set('Authorization', authHeader)
        .set('X-Forwarded-For', '203.0.113.10')
        .send(validCreatePayload());
      expect(res.status).toBe(202);
    }
    expect(counts.createEvent).toBe(WRITE_BURST_CAPACITY);

    // 11th write from same principal must be rejected
    const rejected = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .set('X-Forwarded-For', '203.0.113.10')
      .send(validCreatePayload());

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(parsed.correlationId).toBeDefined();
    expect(Object.keys(rejected.body).toSorted()).toEqual(['correlationId', 'error', 'message']);
    expect(JSON.stringify(rejected.body).length).toBeLessThan(512);
    expect(parseInt(rejected.headers['retry-after'] as string, 10)).toBeGreaterThanOrEqual(1);

    // Secret bearer token must never leak in rejection response
    expect(rejected.text).not.toContain(mockConfig.OPERATOR_ACCESS_TOKEN);

    // Controller/repository must NOT have been called for rejected request
    expect(counts.createEvent).toBe(WRITE_BURST_CAPACITY);
  });

  it('enforces aggregate per-principal limits across rotating source IPs (preventing IP rotation bypass)', async () => {
    let now = 1_000_000;
    const { app, counts } = buildApp(1, () => now);

    // The single operator principal makes 10 requests rotating across 10 distinct IPs
    for (let i = 0; i < WRITE_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .post('/api/v1/intrusion-events')
        .set('Authorization', authHeader)
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .send(validCreatePayload());
      expect(res.status).toBe(202);
    }
    expect(counts.createEvent).toBe(WRITE_BURST_CAPACITY);

    // 11th request with the same principal from an 11th new IP is rejected under aggregate principal quota
    const rejected = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .set('X-Forwarded-For', '198.51.100.99')
      .send(validCreatePayload());
    expect(rejected.status).toBe(429);
    expect(counts.createEvent).toBe(WRITE_BURST_CAPACITY);
  });

  it('bounds unknown route flooding (404) at the default baseline limiter (30 burst)', async () => {
    let now = 1_000_000;
    const { app } = buildApp(1, () => now);

    // Make 30 requests to nonexistent routes
    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .get(`/api/v1/nonexistent-route-${i}`)
        .set('X-Forwarded-For', '198.51.100.30');
      expect(res.status).toBe(404);
    }

    // 31st request from same IP exceeds default quota and returns 429
    const rejected = await request(app)
      .get('/api/v1/nonexistent-route-31')
      .set('X-Forwarded-For', '198.51.100.30');

    expect(rejected.status).toBe(429);
    const parsed = ApiErrorResponseSchema.parse(rejected.body);
    expect(parsed.error).toBe('TOO_MANY_REQUESTS');
    expect(rejected.headers['retry-after']).toBeDefined();
  });

  it('default quota boundary uses authenticated principal when token is provided', async () => {
    let now = 1_000_000;
    const { app } = buildApp(1, () => now);

    // 30 requests to unknown routes with valid operator token consume the principal's default quota
    for (let i = 0; i < DEFAULT_BURST_CAPACITY; i += 1) {
      const res = await request(app)
        .get(`/api/v1/unknown-${i}`)
        .set('Authorization', authHeader)
        .set('X-Forwarded-For', `203.0.113.${i + 1}`);
      expect(res.status).toBe(404);
    }

    // 31st request from a new IP with the same token is rejected because principal's default quota is exhausted
    const rejected = await request(app)
      .get('/api/v1/unknown-31')
      .set('Authorization', authHeader)
      .set('X-Forwarded-For', '203.0.113.200');
    expect(rejected.status).toBe(429);
  });

  it('ignores forwarding headers when TRUST_PROXY_HOPS is 0 and honors them when configured', async () => {
    let now = 1_000_000;

    // Closed App (0 hops): all requests share local socket IP
    const { app: closedApp } = buildApp(0, () => now);
    for (let i = 0; i < HEALTH_BURST_CAPACITY; i += 1) {
      const ip = i % 2 === 0 ? '203.0.113.10' : '203.0.113.20';
      const res = await request(closedApp).get('/api/v1/health').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
    }
    const exhaustedClosed = await request(closedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.10');
    expect(exhaustedClosed.status).toBe(429);

    // Trusted App (1 hop): isolates distinct spoofed/forwarded IPs on IP-keyed limiters (health)
    const { app: trustedApp } = buildApp(1, () => now);
    for (let i = 0; i < HEALTH_BURST_CAPACITY; i += 1) {
      const res = await request(trustedApp)
        .get('/api/v1/health')
        .set('X-Forwarded-For', '203.0.113.10');
      expect(res.status).toBe(200);
    }
    const exhaustedTrusted = await request(trustedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.10');
    expect(exhaustedTrusted.status).toBe(429);

    const otherIp = await request(trustedApp)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.11');
    expect(otherIp.status).toBe(200);
  });

  it('bounds repeated authentication failures per source address and isolates across addresses', async () => {
    let now = 1_000_000;
    const { app } = buildApp(1, () => now);

    for (let i = 0; i < ABUSE_BURST_CAPACITY; i += 1) {
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

    // Another IP can still attempt authentication
    const otherIp = await request(app).get('/api/v1/ready').set('X-Forwarded-For', '203.0.113.51');
    expect(otherIp.status).toBe(401);
  });
});
