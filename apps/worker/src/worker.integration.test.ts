import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
import {
  PrismaWorkerRepository,
  type ClaimReleaseOutcome,
  type WorkerRepository,
} from './persistence/worker-repository.js';
import { FakeGeminiAdapter } from './adapters/fake-gemini-adapter.js';
import { DeterministicSimulatedDeceptionAdapter } from './adapters/simulated-deception-agent.js';
import { EventProcessor } from './processor/event-processor.js';
import { evaluateDeceptionPolicy } from './domain/policy-engine.js';
import { SimulatedDeceptionEffectSchema } from '@false-route/contracts';

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

describe('Worker PostgreSQL Integration — Durable Fenced Claim Recovery', () => {
  let db: DatabaseClient;
  let repository: PrismaWorkerRepository;
  const createdFixtureIds = new Set<string>();
  const defaultAgent = new DeterministicSimulatedDeceptionAdapter();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
    repository = new PrismaWorkerRepository(db, {
      claimLeaseDurationMs: 1000,
      maxProcessingAttempts: 3,
    });
  });

  beforeEach(async () => {
    if (createdFixtureIds.size > 0) {
      await db.intrusionEvent.deleteMany({
        where: { id: { in: Array.from(createdFixtureIds) } },
      });
      createdFixtureIds.clear();
    }
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

  async function createTestEvent(
    overrides?: Partial<{
      id: string;
      status: ProcessingStatus;
      usedDecoyCredential: boolean;
      processingClaimToken: string | null;
      processingLeaseExpiresAt: Date | null;
      processingAttemptCount: number;
    }>,
  ) {
    const eventId = overrides?.id ?? randomUUID();
    createdFixtureIds.add(eventId);
    const correlationId = `corr-worker-test-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
        usedDecoyCredential: overrides?.usedDecoyCredential ?? true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: overrides?.status ?? ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
        processingClaimToken: overrides?.processingClaimToken ?? null,
        processingLeaseExpiresAt: overrides?.processingLeaseExpiresAt ?? null,
        processingAttemptCount: overrides?.processingAttemptCount ?? 0,
      },
    });

    return { eventId, correlationId };
  }

  it('claims pending decoy event, evaluates policy, and persists decision atomically with metadata cleared', async () => {
    const { eventId } = await createTestEvent();

    const processor = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(true);
    expect(result.eventId).toBe(eventId);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');

    const updatedEvent = await db.intrusionEvent.findUnique({
      where: { id: eventId },
      include: {
        decision: {
          include: {
            auditRecord: true,
            simulatedEffect: true,
          },
        },
      },
    });

    expect(updatedEvent?.status).toBe(ProcessingStatus.DECIDED);
    expect(updatedEvent?.processingClaimToken).toBeNull();
    expect(updatedEvent?.processingLeaseExpiresAt).toBeNull();
    expect(updatedEvent?.processingAttemptCount).toBe(1);
    expect(updatedEvent?.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(updatedEvent?.decision?.auditRecord).toBeDefined();
    expect(updatedEvent?.decision?.simulatedEffect).toBeDefined();
    expect(updatedEvent?.decision?.simulatedEffect?.status).toBe('RECORDED');
    expect(updatedEvent?.decision?.simulatedEffect?.containmentMode).toBe('SIMULATED');
    expect(updatedEvent?.decision?.simulatedEffect?.assignedFalseRoute).toBe('mock-admin-decoy');
    expect(updatedEvent?.decision?.simulatedEffect?.provenance).toBe('DERIVED');
  });

  it('prevents race conditions across concurrent workers claiming the same event', async () => {
    const { eventId } = await createTestEvent();

    const processor1 = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const processor2 = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const [res1, res2] = await Promise.all([
      processor1.processNextPending(),
      processor2.processNextPending(),
    ]);

    const processedEvents = [res1, res2].filter((r) => r.eventId === eventId);
    expect(processedEvents.length).toBe(1);
    expect(processedEvents[0]?.processed).toBe(true);
  });

  it('reclaims an expired PROCESSING claim, generates a new claim token, and increments attempt count', async () => {
    const initialToken = randomUUID();
    const expiredDate = new Date(Date.now() - 5000);
    const { eventId } = await createTestEvent({
      status: ProcessingStatus.PROCESSING,
      processingClaimToken: initialToken,
      processingLeaseExpiresAt: expiredDate,
      processingAttemptCount: 1,
    });

    const claim = await repository.claimNextPendingEvent({ leaseDurationMs: 5000, maxAttempts: 3 });
    expect(claim).not.toBeNull();
    expect(claim?.event.id).toBe(eventId);
    expect(claim?.claimToken).not.toBe(initialToken);

    const row = await db.intrusionEvent.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe(ProcessingStatus.PROCESSING);
    expect(row?.processingClaimToken).toBe(claim?.claimToken);
    expect(row?.processingAttemptCount).toBe(2);
  });

  it('does not reclaim a non-expired claim', async () => {
    const activeToken = randomUUID();
    const activeLease = new Date(Date.now() + 60000);
    const { eventId } = await createTestEvent({
      status: ProcessingStatus.PROCESSING,
      processingClaimToken: activeToken,
      processingLeaseExpiresAt: activeLease,
      processingAttemptCount: 1,
    });

    const claim = await repository.claimNextPendingEvent();
    expect(claim?.event.id).not.toBe(eventId);
  });

  it('rejects persistence from a stale worker after another worker reclaims the event', async () => {
    const staleToken = randomUUID();
    const expiredDate = new Date(Date.now() - 5000);
    const { eventId } = await createTestEvent({
      status: ProcessingStatus.PROCESSING,
      processingClaimToken: staleToken,
      processingLeaseExpiresAt: expiredDate,
      processingAttemptCount: 1,
    });

    // Worker 2 reclaims the event
    const freshClaim = await repository.claimNextPendingEvent({
      leaseDurationMs: 5000,
      maxAttempts: 3,
    });
    expect(freshClaim?.event.id).toBe(eventId);
    const freshToken = freshClaim!.claimToken;

    // Stale Worker 1 attempts to persist with stale token
    const staleDecision = evaluateDeceptionPolicy({
      event: freshClaim!.event,
      decisionId: randomUUID(),
    });
    const staleEffect = SimulatedDeceptionEffectSchema.parse({
      id: randomUUID(),
      decisionId: staleDecision.id,
      correlationId: staleDecision.correlationId,
      effectKind: 'ASSIGN_FALSE_ROUTE',
      status: 'RECORDED',
      containmentMode: 'SIMULATED',
      assignedFalseRoute: 'mock-admin-decoy',
      provenance: 'DERIVED',
      recordedAt: new Date().toISOString(),
      adapterVersion: 'simulated-deception-agent-v1',
    });

    await expect(
      repository.persistDecision(staleDecision, staleToken, staleEffect),
    ).rejects.toThrow(/Claim fencing violation/);

    // Fresh worker can persist successfully
    const freshDecision = evaluateDeceptionPolicy({
      event: freshClaim!.event,
      decisionId: randomUUID(),
    });
    const freshEffect = SimulatedDeceptionEffectSchema.parse({
      id: randomUUID(),
      decisionId: freshDecision.id,
      correlationId: freshDecision.correlationId,
      effectKind: 'ASSIGN_FALSE_ROUTE',
      status: 'RECORDED',
      containmentMode: 'SIMULATED',
      assignedFalseRoute: 'mock-admin-decoy',
      provenance: 'DERIVED',
      recordedAt: new Date().toISOString(),
      adapterVersion: 'simulated-deception-agent-v1',
    });
    await repository.persistDecision(freshDecision, freshToken, freshEffect);

    const finalized = await db.intrusionEvent.findUnique({
      where: { id: eventId },
      include: { decision: { include: { simulatedEffect: true } } },
    });
    expect(finalized?.status).toBe(ProcessingStatus.DECIDED);
    expect(finalized?.decision?.simulatedEffect).toBeDefined();
  });

  it('dead-letters an expired PROCESSING event to FAILED after reaching maximum attempts', async () => {
    const expiredDate = new Date(Date.now() - 5000);
    const { eventId } = await createTestEvent({
      status: ProcessingStatus.PROCESSING,
      processingClaimToken: randomUUID(),
      processingLeaseExpiresAt: expiredDate,
      processingAttemptCount: 3,
    });

    const claim = await repository.claimNextPendingEvent({ maxAttempts: 3 });
    expect(claim?.event.id).not.toBe(eventId);

    const row = await db.intrusionEvent.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe(ProcessingStatus.FAILED);
    expect(row?.processingClaimToken).toBeNull();
    expect(row?.processingLeaseExpiresAt).toBeNull();
  });

  it('requeues a failed attempt to PENDING when attempts remain, and marks FAILED after max attempts', async () => {
    const claimToken = randomUUID();
    const { eventId } = await createTestEvent({
      status: ProcessingStatus.PROCESSING,
      processingClaimToken: claimToken,
      processingLeaseExpiresAt: new Date(Date.now() + 10000),
      processingAttemptCount: 1,
    });

    const outcome1 = await repository.releaseOrFailClaim(eventId, claimToken, { maxAttempts: 2 });
    expect(outcome1).toBe('REQUEUED');

    let row = await db.intrusionEvent.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe(ProcessingStatus.PENDING);
    expect(row?.processingClaimToken).toBeNull();

    const claim2 = await repository.claimNextPendingEvent({ maxAttempts: 2 });
    expect(claim2?.event.id).toBe(eventId);
    expect(claim2?.claimToken).toBeDefined();

    const outcome2 = await repository.releaseOrFailClaim(eventId, claim2!.claimToken, {
      maxAttempts: 2,
    });
    expect(outcome2).toBe('FAILED');

    row = await db.intrusionEvent.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe(ProcessingStatus.FAILED);
    expect(row?.processingClaimToken).toBeNull();
  });

  it('reconciles a decision that commits durably before persistence reports failure', async () => {
    const { eventId } = await createTestEvent();
    let releaseOutcome: ClaimReleaseOutcome | undefined;

    const uncertainCommitRepository: WorkerRepository = {
      claimNextPendingEvent: (options) => repository.claimNextPendingEvent(options),
      persistDecision: async (decision, claimToken, simulatedEffect) => {
        await repository.persistDecision(decision, claimToken, simulatedEffect);
        throw new Error('Simulated post-commit acknowledgement failure');
      },
      releaseOrFailClaim: async (claimedEventId, claimToken, options) => {
        releaseOutcome = await repository.releaseOrFailClaim(claimedEventId, claimToken, options);
        return releaseOutcome;
      },
    };

    const processor = new EventProcessor({
      repository: uncertainCommitRepository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    await expect(processor.processNextPending()).rejects.toThrow(
      'Simulated post-commit acknowledgement failure',
    );
    expect(releaseOutcome).toBe('ALREADY_DECIDED');

    const row = await db.intrusionEvent.findUnique({
      where: { id: eventId },
      include: {
        decision: {
          include: {
            auditRecord: true,
            simulatedEffect: true,
          },
        },
      },
    });
    expect(row?.status).toBe(ProcessingStatus.DECIDED);
    expect(row?.processingClaimToken).toBeNull();
    expect(row?.processingLeaseExpiresAt).toBeNull();
    expect(row?.decision?.eventId).toBe(eventId);
    expect(row?.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(row?.decision?.auditRecord).not.toBeNull();
    expect(row?.decision?.simulatedEffect).not.toBeNull();
  });
});
