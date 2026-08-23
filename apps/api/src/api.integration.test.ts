import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createDatabaseClient,
  validateTestDatabaseUrl,
  type DatabaseClient,
} from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { createApp } from './app.js';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const mockConfig = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  PORT: 3000,
  DATABASE_URL: TEST_DATABASE_URL,
  OPERATOR_ACCESS_TOKEN: 'integration-test-operator-token-xyz',
  CORS_ORIGINS: 'http://localhost:5173',
  ENABLE_TELEMETRY: false,
  TRUST_PROXY_HOPS: 0,
};

const noopLogger = createLogger({
  serviceName: 'api-integration-test',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

describe('API PostgreSQL Integration Tests', () => {
  let db: DatabaseClient;
  let app: ReturnType<typeof createApp>;
  const authHeader = `Bearer ${mockConfig.OPERATOR_ACCESS_TOKEN}`;
  const createdFixtureIds = new Set<string>();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
    app = createApp({ config: mockConfig, db, logger: noopLogger });
  });

  afterAll(async () => {
    if (db) {
      if (createdFixtureIds.size > 0) {
        await db.intrusionEvent.deleteMany({
          where: { id: { in: Array.from(createdFixtureIds) } },
        });
      }
      await db.$disconnect();
    }
  });

  it('verifies live readiness check probe against PostgreSQL', async () => {
    const res = await request(app).get('/api/v1/ready').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('connected');
  });

  it('persists and retrieves simulated intrusion events through full HTTP stack', async () => {
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-api-int-${Date.now()}`;

    const eventPayload = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId,
      sourceIp: '198.51.100.42',
      targetAsset: 'mock-admin-portal',
      eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
      failedLoginCount: 5,
      riskIndicators: ['credential_burst', 'suspicious_origin'],
      containmentMode: 'SIMULATED',
      usedDecoyCredential: true,
      decoyIdentifier: 'mock-admin-decoy-creds',
    };

    // 1. Post new intrusion event
    const postRes = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(eventPayload);

    expect(postRes.status).toBe(202);
    expect(postRes.body.id).toBe(eventId);
    expect(postRes.body.status).toBe('PENDING');

    // 2. Fetch event by ID
    const getRes = await request(app)
      .get(`/api/v1/intrusion-events/${eventId}`)
      .set('Authorization', authHeader);

    expect(getRes.status).toBe(200);
    expect(getRes.body.event.id).toBe(eventId);
    expect(getRes.body.event.sourceIp).toBe('198.51.100.42');
    expect(getRes.body.event.status).toBe('PENDING');

    // 3. Query event list and ensure it includes the created event
    const listRes = await request(app)
      .get('/api/v1/intrusion-events')
      .set('Authorization', authHeader);

    expect(listRes.status).toBe(200);
    expect(listRes.body.events.some((e: { id: string }) => e.id === eventId)).toBe(true);
  });

  it('retrieves an event and decision with persisted simulated effect evidence', async () => {
    const eventId = randomUUID();
    const decisionId = randomUUID();
    const effectId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-api-eff-${Date.now()}`;

    // 1. Seed event in PostgreSQL
    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId,
        sourceIp: '198.51.100.43',
        targetAsset: 'mock-admin-portal',
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        failedLoginCount: 2,
        riskIndicators: ['decoy_creds'],
        containmentMode: 'SIMULATED',
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: 'DECIDED',
        provenance: 'OBSERVED',
        decision: {
          create: {
            id: decisionId,
            correlationId,
            action: 'ASSIGN_FALSE_ROUTE',
            assignedFalseRoute: 'mock-admin-decoy',
            matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
            reason: 'Decoy credential used.',
            containmentMode: 'SIMULATED',
            decisionProvenance: 'DERIVED',
            decidedAt: new Date(),
            auditRecord: {
              create: {
                id: randomUUID(),
                ruleVersion: '2026.08.1',
                evaluatedAt: new Date(),
              },
            },
            simulatedEffect: {
              create: {
                id: effectId,
                correlationId,
                effectKind: 'ASSIGN_FALSE_ROUTE',
                status: 'RECORDED',
                containmentMode: 'SIMULATED',
                assignedFalseRoute: 'mock-admin-decoy',
                provenance: 'DERIVED',
                recordedAt: new Date(),
                adapterVersion: 'simulated-deception-agent-v1',
              },
            },
          },
        },
      },
    });

    // 2. Fetch event detail
    const eventRes = await request(app)
      .get(`/api/v1/intrusion-events/${eventId}`)
      .set('Authorization', authHeader);

    expect(eventRes.status).toBe(200);
    expect(eventRes.body.event.id).toBe(eventId);
    expect(eventRes.body.decision.id).toBe(decisionId);
    expect(eventRes.body.decision.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(eventRes.body.simulatedEffect).toBeDefined();
    expect(eventRes.body.simulatedEffect.id).toBe(effectId);
    expect(eventRes.body.simulatedEffect.status).toBe('RECORDED');
    expect(eventRes.body.simulatedEffect.containmentMode).toBe('SIMULATED');
    expect(eventRes.body.simulatedEffect.assignedFalseRoute).toBe('mock-admin-decoy');

    // 3. Fetch decision detail
    const decisionRes = await request(app)
      .get(`/api/v1/intrusion-events/${eventId}/decision`)
      .set('Authorization', authHeader);

    expect(decisionRes.status).toBe(200);
    expect(decisionRes.body.decision.id).toBe(decisionId);
    expect(decisionRes.body.simulatedEffect.id).toBe(effectId);
    expect(decisionRes.body.simulatedEffect.status).toBe('RECORDED');
  });
});
