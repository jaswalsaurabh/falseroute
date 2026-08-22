import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createDatabaseClient,
  validateTestDatabaseUrl,
  type DatabaseClient,
  ProcessingStatus,
  ContainmentMode,
  EventType,
  ProvenanceClassification,
} from '@false-route/database';
import { createLogger } from '@false-route/observability';
import { PrismaWorkerRepository } from './persistence/worker-repository.js';
import { FakeGeminiAdapter } from './adapters/fake-gemini-adapter.js';
import { EventProcessor } from './processor/event-processor.js';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const noopLogger = createLogger({
  serviceName: 'worker-integration-test',
  destination: new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
});

describe('Worker PostgreSQL Integration', () => {
  let db: DatabaseClient;
  let repository: PrismaWorkerRepository;
  const createdFixtureIds = new Set<string>();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
    repository = new PrismaWorkerRepository(db);
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

  it('claims pending decoy event, evaluates policy, and persists decision and audit atomically', async () => {
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-worker-int-${Date.now()}`;

    // 1. Seed pending decoy event
    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId,
        sourceIp: '192.0.2.77',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 4,
        riskIndicators: ['credential_stuffing_burst'],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });

    const processor = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      logger: noopLogger,
    });

    // 2. Process next pending
    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.eventId).toBe(eventId);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');

    // 3. Verify in database
    const updatedEvent = await db.intrusionEvent.findUnique({
      where: { id: eventId },
      include: {
        decision: {
          include: {
            auditRecord: true,
          },
        },
      },
    });

    expect(updatedEvent?.status).toBe(ProcessingStatus.DECIDED);
    expect(updatedEvent?.decision).toBeDefined();
    expect(updatedEvent?.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(updatedEvent?.decision?.assignedFalseRoute).toBe('mock-admin-decoy');
    expect(updatedEvent?.decision?.containmentMode).toBe('SIMULATED');
    expect(updatedEvent?.decision?.auditRecord).toBeDefined();
    expect(updatedEvent?.decision?.auditRecord?.ruleVersion).toBe('2026.08.1');
  });

  it('prevents race conditions across concurrent workers claiming the same event', async () => {
    const eventId = randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-worker-race-${Date.now()}`;

    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId,
        sourceIp: '192.0.2.88',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 1,
        riskIndicators: [],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });

    const processor1 = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      logger: noopLogger,
    });

    const processor2 = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      logger: noopLogger,
    });

    // Run both concurrently
    const [res1, res2] = await Promise.all([
      processor1.processNextPending(),
      processor2.processNextPending(),
    ]);

    // Exactly one must succeed for this eventId
    const processedEvents = [res1, res2].filter((r) => r.eventId === eventId);
    expect(processedEvents.length).toBe(1);
    expect(processedEvents[0]?.processed).toBe(true);
  });
});
