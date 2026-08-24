import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createDatabaseClient,
  validateTestDatabaseUrl,
  type DatabaseClient,
  AutonomousWorkflowRepository,
  ActivityEventRepository,
} from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { createApp } from '@false-route/api';
import {
  AutonomousWorkflowOrchestrator,
  LocalSharedSecretOidcTokenVerifier,
  PubSubPushHandler,
  ToolGateway,
  FakeAutonomousGeminiAdapter,
} from '@false-route/worker';
import { type CreateAutonomousScenarioRequest } from '@false-route/contracts';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const OPERATOR_TOKEN = 'autonomous-integration-test-token-888';
const LOCAL_PUSH_SECRET = 'not-a-real-autonomous-push-secret-12345';

const noopLogger = createLogger({
  serviceName: 'autonomous-system-integration-test',
  destination: new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }),
});

describe('Autonomous System Integration — Full Vertical Slice (API Scenario → Publisher → Worker Push → ToolGateway → Leases & Activity → API Snapshot)', () => {
  let db: DatabaseClient;
  let app: ReturnType<typeof createApp>;
  let workflowRepo: AutonomousWorkflowRepository;
  let activityRepo: ActivityEventRepository;
  let pushHandler: PubSubPushHandler;
  const authHeader = `Bearer ${OPERATOR_TOKEN}`;
  const createdFixtureIds = new Set<string>();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();

    workflowRepo = new AutonomousWorkflowRepository(db);
    activityRepo = new ActivityEventRepository(db);

    // Setup worker push handler and orchestrator
    const toolGateway = new ToolGateway(workflowRepo, activityRepo);
    const orchestrator = new AutonomousWorkflowOrchestrator(
      workflowRepo,
      activityRepo,
      toolGateway,
      new FakeAutonomousGeminiAdapter('auto'),
    );
    const oidcVerifier = new LocalSharedSecretOidcTokenVerifier(LOCAL_PUSH_SECRET);
    pushHandler = new PubSubPushHandler(orchestrator, oidcVerifier, workflowRepo);

    // In-memory publisher that immediately dispatches to worker push handler
    const directPushPublisher = {
      publish: async (envelope: unknown) => {
        const messageId = `msg-auto-int-${randomUUID()}`;
        const pushEnvelope = {
          message: {
            data: Buffer.from(JSON.stringify(envelope)).toString('base64'),
            messageId,
            publishTime: new Date().toISOString(),
          },
          subscription: 'projects/falseroute-local/subscriptions/worker-push',
        };
        const pushResult = await pushHandler.handlePushRequest(
          `Bearer ${LOCAL_PUSH_SECRET}`,
          pushEnvelope,
        );
        if (pushResult.statusCode !== 200) {
          throw new Error(`Push delivery failed: HTTP ${pushResult.statusCode}`);
        }
        return { transportId: messageId };
      },
    };

    // Instantiate API with real DB and configured direct publisher
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
      eventPublisher: directPushPublisher,
    });
  });

  afterAll(async () => {
    if (db) {
      if (createdFixtureIds.size > 0) {
        const fixtureIds = Array.from(createdFixtureIds);
        await db.decoyDeploymentLease.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.falseRouteLease.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.quarantineLease.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.toolOperationLedger.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.activityEventRecord.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.ingestionReceipt.deleteMany({ where: { eventId: { in: fixtureIds } } });
        await db.intrusionEvent.deleteMany({ where: { id: { in: fixtureIds } } });
      }
      await db.$disconnect();
    }
  });

  it('executes positive ENV_FILE_PROBE scenario: API Scenario Ingest -> Push -> Autonomous Orchestrator -> Decoy Lease & Activity Stream', async () => {
    const eventId = randomUUID();
    const scenarioPayload: CreateAutonomousScenarioRequest = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId: `corr-auto-pos-${Date.now()}`,
      scenarioKind: 'ENV_FILE_PROBE',
      sourceIp: '198.51.100.25',
      evidence: {
        scenarioKind: 'ENV_FILE_PROBE',
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
      },
    };

    // 1. Post scenario through strict endpoint
    const postRes = await request(app)
      .post('/api/v1/intrusion-events/scenarios')
      .set('Authorization', authHeader)
      .send(scenarioPayload);

    expect(postRes.status).toBe(202);
    expect(postRes.body.status).toBe('PENDING');
    expect(postRes.body.id).toBe(eventId);
    createdFixtureIds.add(eventId);

    // 2. Verify persisted IntrusionEvent in database
    const dbEvent = await db.intrusionEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    expect(dbEvent.scenarioKind).toBe('ENV_FILE_PROBE');
    expect(dbEvent.evidence).toBeDefined();

    // 3. Verify DecoyDeploymentLease was created by autonomous orchestrator
    const leases = await db.decoyDeploymentLease.findMany({
      where: { eventId },
    });
    expect(leases).toHaveLength(1);
    expect(leases[0]?.templateName).toBe('mock-admin-decoy');
    expect(leases[0]?.leaseStatus).toBe('ACTIVE');

    // 4. Verify ToolOperationLedger was recorded idempotently
    const operations = await db.toolOperationLedger.findMany({
      where: { eventId },
    });
    expect(operations).toHaveLength(3);
    const toolNames = operations.map((op) => op.toolName);
    expect(toolNames).toContain('request_decoy_deployment');
    expect(toolNames).toContain('request_false_route_assignment');
    expect(toolNames).toContain('request_operator_alert');
    expect(operations.every((op) => op.authorized)).toBe(true);

    // 5. Verify ActivityEventRecords were persisted and are returned via Activity API
    const activityRes = await request(app).get('/api/v1/activity').set('Authorization', authHeader);

    expect(activityRes.status).toBe(200);
    const relatedEvents = (
      activityRes.body.events as Array<{ eventId: string; eventType: string }>
    ).filter((e) => e.eventId === eventId);
    expect(relatedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects contradictory evidence at API validation boundary before persistence or dispatch', async () => {
    const invalidPayload = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: `corr-auto-invalid-${Date.now()}`,
      scenarioKind: 'ENV_FILE_PROBE',
      sourceIp: '198.51.100.25',
      evidence: {
        scenarioKind: 'ENV_FILE_PROBE',
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
        isNegativeControl: true, // Contradictory!
      },
    };

    const postRes = await request(app)
      .post('/api/v1/intrusion-events/scenarios')
      .set('Authorization', authHeader)
      .send(invalidPayload);

    expect(postRes.status).toBe(400);
    expect(postRes.body.error).toBe('VALIDATION_ERROR');
  });

  it('executes negative control safely: does NOT create lease or execute mutating tools', async () => {
    const eventId = randomUUID();
    const negativePayload: CreateAutonomousScenarioRequest = {
      id: eventId,
      occurredAt: new Date().toISOString(),
      correlationId: `corr-auto-neg-${Date.now()}`,
      scenarioKind: 'WORDPRESS_CONFIG_PROBE',
      sourceIp: '198.51.100.26',
      evidence: {
        scenarioKind: 'WORDPRESS_CONFIG_PROBE',
        requestedPath: '/wp-config.php',
        matchedString: 'wp-config.php',
        httpMethod: 'GET',
        userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
        sourceIp: '198.51.100.26',
        isPositiveMatch: false,
        isNegativeControl: true,
      },
    };

    const postRes = await request(app)
      .post('/api/v1/intrusion-events/scenarios')
      .set('Authorization', authHeader)
      .send(negativePayload);

    expect(postRes.status).toBe(202);
    expect(postRes.body.id).toBe(eventId);
    createdFixtureIds.add(eventId);

    // Verify NO leases were created for negative control
    const leases = await db.decoyDeploymentLease.findMany({
      where: { eventId },
    });
    expect(leases).toHaveLength(0);

    const routes = await db.falseRouteLease.findMany({
      where: { eventId },
    });
    expect(routes).toHaveLength(0);
  });
});
