import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutonomousWorkflowRepository,
  ContainmentMode,
  createDatabaseClient,
  EventType,
  type DatabaseClient,
  ProcessingStatus,
  ProvenanceClassification,
  validateTestDatabaseUrl,
} from './index.js';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

describe('Autonomous workflow PostgreSQL ownership', () => {
  let db: DatabaseClient;
  let eventId: string;

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
    eventId = randomUUID();
    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId: `corr-autonomous-${Date.now()}`,
        sourceIp: '198.51.100.80',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 1,
        riskIndicators: ['synthetic_autonomous_test'],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: false,
        status: ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });
  });

  afterAll(async () => {
    if (db) {
      await db.replayAttempt.deleteMany({ where: { originalEventId: eventId } });
      await db.deadLetterRecord.deleteMany({ where: { originalEventId: eventId } });
      await db.intrusionEvent.deleteMany({ where: { id: eventId } });
      await db.$disconnect();
    }
  });

  it('atomically owns concurrent ingestion, tool operations, provider intent, leases, and replay', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const receipts = await Promise.all([
      repository.recordIngestionReceipt({
        eventId,
        transportId: 'ps-example-concurrent',
        source: 'PUB_SUB',
      }),
      repository.recordIngestionReceipt({
        eventId,
        transportId: 'ps-example-concurrent',
        source: 'PUB_SUB',
      }),
    ]);
    expect(receipts.filter((result) => !result.isDuplicate)).toHaveLength(1);
    expect(receipts.filter((result) => result.isDuplicate)).toHaveLength(1);

    const operationParams = {
      idempotencyKey: `idem-request-decoy-${eventId}`,
      eventId,
      toolName: 'request_decoy_deployment',
      authorized: true,
      policyReason: 'Synthetic integration policy',
    };
    const operations = await Promise.all([
      repository.reserveToolOperation({
        ...operationParams,
        input: { templateName: 'mock-admin-decoy', ttlSeconds: 300 },
      }),
      repository.reserveToolOperation({
        ...operationParams,
        input: { ttlSeconds: 300, templateName: 'mock-admin-decoy' },
      }),
    ]);
    expect(operations.filter((result) => !result.isExisting)).toHaveLength(1);
    expect(new Set(operations.map((result) => result.operation.inputHash)).size).toBe(1);

    const claims = await Promise.all([
      repository.claimProviderIntent({
        idempotencyKey: operationParams.idempotencyKey,
        eventId,
        operationType: operationParams.toolName,
        provider: 'CLOUD_RUN',
        claimOwner: 'worker-example-a',
      }),
      repository.claimProviderIntent({
        idempotencyKey: operationParams.idempotencyKey,
        eventId,
        operationType: operationParams.toolName,
        provider: 'CLOUD_RUN',
        claimOwner: 'worker-example-b',
      }),
    ]);
    expect(claims.filter((claim) => claim.disposition === 'CLAIMED')).toHaveLength(1);
    expect(claims.filter((claim) => claim.disposition === 'RECONCILIATION_REQUIRED')).toHaveLength(
      1,
    );

    const leases = await Promise.all([
      repository.createDecoyLease({
        eventId,
        templateName: 'mock-admin-decoy',
        imageDigest: 'sha256:dummy-allowlisted-digest-001',
      }),
      repository.createDecoyLease({
        eventId,
        templateName: 'mock-admin-decoy',
        imageDigest: 'sha256:dummy-allowlisted-digest-001',
      }),
    ]);
    expect(new Set(leases.map((lease) => lease.id)).size).toBe(1);

    const deadLetters = await Promise.all([
      repository.recordDeadLetter({
        originalMessageId: `ps-example-dead-letter-${eventId}`,
        originalEventId: eventId,
        failureReason: 'Synthetic retry exhaustion',
        payload: { eventId, schemaVersion: '1.0.0' },
      }),
      repository.recordDeadLetter({
        originalMessageId: `ps-example-dead-letter-${eventId}`,
        originalEventId: eventId,
        failureReason: 'Synthetic retry exhaustion',
        payload: { schemaVersion: '1.0.0', eventId },
      }),
    ]);
    expect(new Set(deadLetters.map((record) => record.id)).size).toBe(1);
    const replayClaims = await Promise.all([
      repository.claimDeadLetterForReplay({
        deadLetterId: deadLetters[0]!.id,
        requestedBy: 'operator-example-a',
        rationale: 'Synthetic replay concurrency proof',
      }),
      repository.claimDeadLetterForReplay({
        deadLetterId: deadLetters[0]!.id,
        requestedBy: 'operator-example-b',
        rationale: 'Synthetic replay concurrency proof',
      }),
    ]);
    expect(replayClaims.filter((claim) => claim.claimed)).toHaveLength(1);
    const ownedReplay = replayClaims.find((claim) => claim.claimed);
    await repository.failReplayClaim({
      replayAttemptId: ownedReplay!.replayAttempt!.id,
      reason: 'Synthetic publisher uncertainty requires review',
    });
    expect(
      (await db.deadLetterRecord.findUniqueOrThrow({ where: { id: deadLetters[0]!.id } }))
        .replayStatus,
    ).toBe('REVIEW_REQUIRED');
  });

  it('handles application event delivered under two different transport IDs with independent receipts', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const receipt1 = await repository.recordIngestionReceipt({
      eventId,
      transportId: 'ps-transport-attempt-1',
      source: 'PUB_SUB',
    });
    const receipt2 = await repository.recordIngestionReceipt({
      eventId,
      transportId: 'ps-transport-attempt-2',
      source: 'PUB_SUB',
    });

    expect(receipt1.isDuplicate).toBe(false);
    expect(receipt2.isDuplicate).toBe(false);
    expect(receipt1.receipt.id).not.toBe(receipt2.receipt.id);

    const receipts = await db.ingestionReceipt.findMany({
      where: { eventId },
    });
    expect(receipts.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects tool operation idempotency collisions with different input payload', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-collision-check-${eventId}`;

    const op1 = await repository.reserveToolOperation({
      idempotencyKey,
      eventId,
      toolName: 'request_decoy_deployment',
      input: { templateName: 'mock-admin-decoy', ttlSeconds: 300 },
      authorized: true,
      policyReason: 'Initial authorized operation',
    });
    expect(op1.isExisting).toBe(false);

    // Collision with different input must throw
    await expect(
      repository.reserveToolOperation({
        idempotencyKey,
        eventId,
        toolName: 'request_decoy_deployment',
        input: { templateName: 'different-template-name', ttlSeconds: 600 },
        authorized: true,
        policyReason: 'Conflicting operation',
      }),
    ).rejects.toThrow('Tool-operation idempotency collision');
  });

  it('recovers from provider-success / database-write ambiguity without re-executing', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-ambiguity-check-${eventId}`;

    // 1. Initial claim
    const claim1 = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-instance-1',
    });
    expect(claim1.disposition).toBe('CLAIMED');
    expect(claim1.claimToken).toBeDefined();

    // 2. Mark EXECUTED (simulating successful provider call)
    await repository.updateProviderIntentStatus({
      idempotencyKey,
      claimToken: claim1.claimToken!,
      status: 'EXECUTED',
      result: { providerResourceId: 'service-decoy-99', health: 'HEALTHY' },
    });

    // 3. Subsequent worker redelivery or retry checks intent and gets ALREADY_EXECUTED
    const claim2 = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-instance-2',
    });
    expect(claim2.disposition).toBe('ALREADY_EXECUTED');
    expect((claim2.intent.result as Record<string, unknown>)['providerResourceId']).toBe(
      'service-decoy-99',
    );
  });

  it('enforces fencing tokens and owner verification during lease cleanup', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const templateName = `mock-fencing-decoy-${Date.now()}`;
    const lease = await repository.createDecoyLease({
      eventId,
      templateName,
      imageDigest: 'sha256:dummy-fencing-digest-001',
      ownerId: 'cleanup-worker-primary',
    });

    // Stale owner or stale fencing token must fail closed
    await expect(
      repository.markDecoyCleanedUp({
        leaseId: lease.id,
        ownerId: 'wrong-stale-worker',
        fencingToken: lease.fencingToken,
      }),
    ).rejects.toThrow('Decoy lease cleanup fence was lost');

    await expect(
      repository.markDecoyCleanedUp({
        leaseId: lease.id,
        ownerId: 'cleanup-worker-primary',
        fencingToken: lease.fencingToken + 99,
      }),
    ).rejects.toThrow('Decoy lease cleanup fence was lost');

    // Correct owner and fencing token succeeds
    const cleanupResult = await repository.markDecoyCleanedUp({
      leaseId: lease.id,
      ownerId: 'cleanup-worker-primary',
      fencingToken: lease.fencingToken,
    });
    expect(cleanupResult.count).toBe(1);

    // Second cleanup attempt fails because lease is no longer ACTIVE
    await expect(
      repository.markDecoyCleanedUp({
        leaseId: lease.id,
        ownerId: 'cleanup-worker-primary',
        fencingToken: lease.fencingToken,
      }),
    ).rejects.toThrow('Decoy lease cleanup fence was lost');
  });
});
