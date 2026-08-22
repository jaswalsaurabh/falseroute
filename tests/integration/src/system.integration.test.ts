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
import { createApp } from '@false-route/api';
import {
  PrismaWorkerRepository,
  EventProcessor,
  WorkerOrchestrator,
  FakeGeminiAdapter,
  DeterministicSimulatedDeceptionAdapter,
} from '@false-route/worker';
import {
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
  ListIntrusionEventsResponseSchema,
} from '@false-route/contracts';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const OPERATOR_TOKEN = 'system-integration-test-token-777';

const noopLogger = createLogger({
  serviceName: 'system-integration-test',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

describe('System Integration — Full Pipeline (API → DB → Worker → DB → API)', () => {
  let db: DatabaseClient;
  let app: ReturnType<typeof createApp>;
  let fakeAdapter: FakeGeminiAdapter;
  let orchestrator: WorkerOrchestrator;
  const authHeader = `Bearer ${OPERATOR_TOKEN}`;
  const createdFixtureIds = new Set<string>();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();

    // Instantiate real API with real repository and config
    app = createApp({
      config: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: 3000,
        DATABASE_URL: TEST_DATABASE_URL,
        OPERATOR_ACCESS_TOKEN: OPERATOR_TOKEN,
        CORS_ORIGINS: 'http://localhost:5173',
        ENABLE_TELEMETRY: false,
      },
      db,
      logger: noopLogger,
    });

    // Instantiate real worker processor with real worker repository and fake Gemini adapter
    fakeAdapter = new FakeGeminiAdapter('auto');
    const workerRepo = new PrismaWorkerRepository(db);
    const simulatedAgent = new DeterministicSimulatedDeceptionAdapter();
    const processor = new EventProcessor({
      repository: workerRepo,
      geminiAdapter: fakeAdapter,
      simulatedAgent,
      logger: noopLogger,
    });

    orchestrator = new WorkerOrchestrator({
      processor,
      logger: noopLogger,
      pollIntervalMs: 50,
    });

    orchestrator.start();
  });

  afterAll(async () => {
    if (orchestrator) {
      await orchestrator.stop();
    }
    if (db) {
      if (createdFixtureIds.size > 0) {
        await db.intrusionEvent.deleteMany({
          where: { id: { in: Array.from(createdFixtureIds) } },
        });
      }
      await db.$disconnect();
    }
  });

  it('completes positive decoy lifecycle: API ingest -> worker decision -> API verified response with simulated effect', async () => {
    fakeAdapter.setMode('auto');
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-sys-pos-${Date.now()}`;

    const decoyPayload = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId,
      sourceIp: '198.51.100.77',
      targetAsset: 'mock-admin-portal',
      eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
      failedLoginCount: 4,
      riskIndicators: ['decoy_credential_burst'],
      containmentMode: 'SIMULATED',
      usedDecoyCredential: true,
      decoyIdentifier: 'mock-admin-decoy-creds',
    };

    // 1. Post event through Express API
    const postRes = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(decoyPayload);

    expect(postRes.status).toBe(202);
    expect(postRes.body.id).toBe(eventId);
    expect(postRes.body.status).toBe('PENDING');

    // 2. Poll API until background worker claims and decides the event
    let eventDetail: ReturnType<typeof GetIntrusionEventResponseSchema.parse> | null = null;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const getRes = await request(app)
        .get(`/api/v1/intrusion-events/${eventId}`)
        .set('Authorization', authHeader);

      if (getRes.status === 200 && getRes.body.event.status === 'DECIDED') {
        eventDetail = GetIntrusionEventResponseSchema.parse(getRes.body);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(eventDetail).not.toBeNull();
    expect(eventDetail?.event.status).toBe('DECIDED');
    expect(eventDetail?.event.provenance).toBe('OBSERVED');
    expect(eventDetail?.event.containmentMode).toBe('SIMULATED');

    // 3. Verify evaluated decision in API response
    expect(eventDetail?.decision).toBeDefined();
    expect(eventDetail?.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(eventDetail?.decision?.assignedFalseRoute).toBe('mock-admin-decoy');
    expect(eventDetail?.decision?.matchedPolicy).toBe('DECOY_CREDENTIAL_TRIGGER');
    expect(eventDetail?.decision?.containmentMode).toBe('SIMULATED');
    expect(eventDetail?.decision?.decisionProvenance).toBe('DERIVED');
    expect(eventDetail?.decision?.auditRecord.ruleVersion).toBe('2026.08.1');

    // 4. Verify simulated effect evidence in API response
    expect(eventDetail?.simulatedEffect).toBeDefined();
    expect(eventDetail?.simulatedEffect?.status).toBe('RECORDED');
    expect(eventDetail?.simulatedEffect?.containmentMode).toBe('SIMULATED');
    expect(eventDetail?.simulatedEffect?.assignedFalseRoute).toBe('mock-admin-decoy');
    expect(eventDetail?.simulatedEffect?.provenance).toBe('DERIVED');
    expect(eventDetail?.simulatedEffect?.adapterVersion).toBe('simulated-deception-agent-v1');

    // 5. Query decision endpoint directly
    const decisionRes = await request(app)
      .get(`/api/v1/intrusion-events/${eventId}/decision`)
      .set('Authorization', authHeader);

    expect(decisionRes.status).toBe(200);
    const parsedDecision = GetDeceptionDecisionResponseSchema.parse(decisionRes.body);
    expect(parsedDecision.decision.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(parsedDecision.decision.assignedFalseRoute).toBe('mock-admin-decoy');
    expect(parsedDecision.simulatedEffect).toBeDefined();
    expect(parsedDecision.simulatedEffect?.status).toBe('RECORDED');

    // 6. Query event list and ensure decided event is listed
    const listRes = await request(app)
      .get('/api/v1/intrusion-events')
      .set('Authorization', authHeader);

    expect(listRes.status).toBe(200);
    const parsedList = ListIntrusionEventsResponseSchema.parse(listRes.body);
    const found = parsedList.events.find((e) => e.id === eventId);
    expect(found).toBeDefined();
    expect(found?.status).toBe('DECIDED');
  });

  it('completes negative control lifecycle: non-decoy event is never assigned a false route', async () => {
    fakeAdapter.setMode('auto');
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-sys-neg-${Date.now()}`;

    const nonDecoyPayload = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId,
      sourceIp: '203.0.113.88',
      targetAsset: 'mock-admin-portal',
      eventType: 'SUSPICIOUS_LOGIN',
      failedLoginCount: 1,
      riskIndicators: ['unusual_origin'],
      containmentMode: 'SIMULATED',
      usedDecoyCredential: false,
    };

    const postRes = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(nonDecoyPayload);

    expect(postRes.status).toBe(202);

    // Poll until decided
    let eventDetail: ReturnType<typeof GetIntrusionEventResponseSchema.parse> | null = null;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const getRes = await request(app)
        .get(`/api/v1/intrusion-events/${eventId}`)
        .set('Authorization', authHeader);

      if (getRes.status === 200 && getRes.body.event.status === 'DECIDED') {
        eventDetail = GetIntrusionEventResponseSchema.parse(getRes.body);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(eventDetail).not.toBeNull();
    expect(eventDetail?.event.status).toBe('DECIDED');
    expect(eventDetail?.decision?.action).toBe('OBSERVE');
    expect(eventDetail?.decision?.matchedPolicy).toBe('DEFAULT_OBSERVATION');
    expect(eventDetail?.decision?.action).not.toBe('ASSIGN_FALSE_ROUTE');
    expect(eventDetail?.decision?.assignedFalseRoute).toBeUndefined();
  });

  it('handles degraded Gemini model response safely: deterministic decision holds and degradation is recorded honestly', async () => {
    fakeAdapter.setMode('timeout');
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-sys-deg-${Date.now()}`;

    const decoyPayload = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId,
      sourceIp: '198.51.100.99',
      targetAsset: 'mock-admin-portal',
      eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
      failedLoginCount: 5,
      riskIndicators: ['credential_burst'],
      containmentMode: 'SIMULATED',
      usedDecoyCredential: true,
      decoyIdentifier: 'mock-admin-decoy-creds',
    };

    const postRes = await request(app)
      .post('/api/v1/intrusion-events')
      .set('Authorization', authHeader)
      .send(decoyPayload);

    expect(postRes.status).toBe(202);

    // Poll until decided
    let eventDetail: ReturnType<typeof GetIntrusionEventResponseSchema.parse> | null = null;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const getRes = await request(app)
        .get(`/api/v1/intrusion-events/${eventId}`)
        .set('Authorization', authHeader);

      if (getRes.status === 200 && getRes.body.event.status === 'DECIDED') {
        eventDetail = GetIntrusionEventResponseSchema.parse(getRes.body);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(eventDetail).not.toBeNull();
    expect(eventDetail?.event.status).toBe('DECIDED');

    // Deterministic decision is still correctly executed
    expect(eventDetail?.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(eventDetail?.decision?.assignedFalseRoute).toBe('mock-admin-decoy');

    // Model enrichment is recorded honestly with degraded status
    const enrichment = eventDetail?.decision?.modelEnrichment;
    expect(enrichment).toBeDefined();
    expect(enrichment?.provenance).toBe('UNAVAILABLE');
    if (enrichment && 'status' in enrichment) {
      expect(enrichment.status).toBe('TIMEOUT');
      expect(enrichment.reason).toContain('timeout');
    }
  });
});
