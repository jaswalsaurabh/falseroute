import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { type DatabaseClient } from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { createApp } from './app.js';
import { type ApiRepository } from './persistence/api-repository.js';
import {
  CreateIntrusionEventResponseSchema,
  ListIntrusionEventsResponseSchema,
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
  ApiErrorResponseSchema,
  HealthCheckResponseSchema,
  ReadinessCheckResponseSchema,
  type IntrusionEvent,
  type DeceptionDecision,
} from '@false-route/contracts';

const mockConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://fake:fake@127.0.0.1:5432/fake',
  OPERATOR_ACCESS_TOKEN: 'test-secret-operator-token-12345',
  CORS_ORIGINS: 'http://localhost:5173',
  ENABLE_TELEMETRY: false,
};

const mockLogger = createLogger({
  serviceName: 'test-api',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

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

const mockDecision: DeceptionDecision = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  eventId: mockDecoyEvent.id,
  correlationId: mockDecoyEvent.correlationId,
  action: 'ASSIGN_FALSE_ROUTE',
  assignedFalseRoute: 'mock-admin-decoy',
  matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
  reason: 'Approved decoy credential accessed target asset.',
  containmentMode: 'SIMULATED',
  decisionProvenance: 'DERIVED',
  decidedAt: '2026-08-22T00:00:02.000Z',
  auditRecord: { ruleVersion: '2026.08.1', evaluatedAt: '2026-08-22T00:00:02.000Z' },
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
      return id === mockDecoyEvent.id ? { event: mockDecoyEvent, decision: mockDecision } : null;
    },
    async getDecisionByEventId(eventId: string) {
      return eventId === mockDecoyEvent.id ? mockDecision : null;
    },
    async checkHealth() {
      return true;
    },
  };
}

describe('Express API Unit Tests', () => {
  const repository = createMockRepository();
  const mockDb = {} as DatabaseClient;
  const app = createApp({ config: mockConfig, db: mockDb, logger: mockLogger, repository });

  const authHeader = `Bearer ${mockConfig.OPERATOR_ACCESS_TOKEN}`;

  it('allows unauthenticated access to liveness endpoint', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    const parsed = HealthCheckResponseSchema.parse(res.body);
    expect(parsed.status).toBe('ok');
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('rejects unauthenticated access to readiness endpoint', async () => {
    const res = await request(app).get('/api/v1/ready');
    expect(res.status).toBe(401);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('UNAUTHORIZED');
  });

  it('allows authenticated access to readiness endpoint', async () => {
    const res = await request(app).get('/api/v1/ready').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const parsed = ReadinessCheckResponseSchema.parse(res.body);
    expect(parsed.status).toBe('ready');
  });

  it('rejects unauthenticated requests to intrusion events endpoints', async () => {
    const res = await request(app).get('/api/v1/intrusion-events');
    expect(res.status).toBe(401);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('UNAUTHORIZED');
  });

  it('accepts valid intrusion event creation when authenticated', async () => {
    const {
      status: _status,
      provenance: _prov,
      receivedAt: _rec,
      ...createPayload
    } = mockDecoyEvent;

    const res = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(createPayload);

    expect(res.status).toBe(202);
    const parsed = CreateIntrusionEventResponseSchema.parse(res.body);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.id).toBe(createPayload.id);
  });

  it('rejects malformed intrusion event payload with 400 and validation details', async () => {
    const invalidPayload = {
      id: 'not-a-uuid',
      eventType: 'INVALID_EVENT_TYPE',
    };

    const res = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(invalidPayload);

    expect(res.status).toBe(400);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('VALIDATION_ERROR');
    expect(parsed.details).toBeDefined();
    expect(parsed.details?.length).toBeGreaterThan(0);
  });

  it('returns paginated intrusion events list adhering to schema', async () => {
    const res = await request(app).get('/api/v1/intrusion-events').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const parsed = ListIntrusionEventsResponseSchema.parse(res.body);
    expect(parsed.events.length).toBe(1);
    expect(parsed.total).toBe(1);
  });

  it('returns single intrusion event with decision adhering to schema', async () => {
    const res = await request(app)
      .get(`/api/v1/intrusion-events/${mockDecoyEvent.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const parsed = GetIntrusionEventResponseSchema.parse(res.body);
    expect(parsed.event.id).toBe(mockDecoyEvent.id);
    expect(parsed.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
  });

  it('returns 404 for non-existent event ID', async () => {
    const res = await request(app)
      .get('/api/v1/intrusion-events/c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a99')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('NOT_FOUND');
  });

  it('returns deception decision for an event adhering to schema', async () => {
    const res = await request(app)
      .get(`/api/v1/intrusion-events/${mockDecoyEvent.id}/decision`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const parsed = GetDeceptionDecisionResponseSchema.parse(res.body);
    expect(parsed.decision.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(parsed.decision.assignedFalseRoute).toBe('mock-admin-decoy');
  });

  it('does not expose internal stack traces, messages, or secrets in response or emitted logs on server error', async () => {
    let capturedLog = '';
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLog += chunk.toString();
        callback();
      },
    });
    const probeLogger = createLogger({
      serviceName: 'test-api-probe',
      destination: captureStream,
    });

    const errorRepo = createMockRepository();
    vi.spyOn(errorRepo, 'listEvents').mockRejectedValueOnce(
      new Error('Secret DB password exposed in exception: p@ssword!'),
    );

    const errorApp = createApp({
      config: mockConfig,
      db: mockDb,
      logger: probeLogger,
      repository: errorRepo,
    });

    const res = await request(errorApp)
      .get('/api/v1/intrusion-events')
      .set('Authorization', authHeader);

    expect(res.status).toBe(500);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('INTERNAL_SERVER_ERROR');
    expect(res.text).not.toContain('p@ssword!');

    // Verify emitted log probe: raw error message and secrets are strictly absent
    expect(capturedLog).not.toContain('p@ssword!');
    expect(capturedLog).not.toContain('Secret DB password exposed in exception');
    expect(capturedLog).toContain('Unhandled internal server error');
    expect(capturedLog).toContain('"errorType":"Error"');
  });

  it('returns 400 Bad Request with correlation metadata on malformed JSON payload syntax', async () => {
    const customCorrelationId = 'corr-malformed-json-test-01';
    const res = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .set('X-Correlation-Id', customCorrelationId)
      .set('Content-Type', 'application/json')
      .send('{"invalidJson": unquotedValue}');

    expect(res.status).toBe(400);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('BAD_REQUEST');
    expect(parsed.message).toContain('Malformed JSON payload');
    expect(parsed.correlationId).toBe(customCorrelationId);
  });

  it('returns 413 Payload Too Large with correlation metadata when request body exceeds 64kb limit', async () => {
    const customCorrelationId = 'corr-payload-too-large-01';
    const hugePayload = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      junkData: 'x'.repeat(70 * 1024),
    };

    const res = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .set('X-Correlation-Id', customCorrelationId)
      .send(hugePayload);

    expect(res.status).toBe(413);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);
    const parsed = ApiErrorResponseSchema.parse(res.body);
    expect(parsed.error).toBe('PAYLOAD_TOO_LARGE');
    expect(parsed.correlationId).toBe(customCorrelationId);
  });

  it('sanitizes overlong caller correlation IDs to valid bounded correlation ID', async () => {
    const overlongCorrelationId = 'a'.repeat(200);

    const res = await request(app)
      .get('/api/v1/health')
      .set('X-Correlation-Id', overlongCorrelationId);

    expect(res.status).toBe(200);
    const returnedCorrelationId = res.headers['x-correlation-id'];
    expect(returnedCorrelationId).toBeDefined();
    expect(returnedCorrelationId?.length).toBeLessThanOrEqual(64);
    expect(returnedCorrelationId).not.toBe(overlongCorrelationId);
  });
});
