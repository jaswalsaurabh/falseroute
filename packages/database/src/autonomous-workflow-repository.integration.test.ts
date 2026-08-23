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
    await db.emergencyReleaseRecord.deleteMany();
    await db.cleanupSweepRecord.deleteMany();
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
      await db.emergencyReleaseRecord.deleteMany();
      await db.cleanupSweepRecord.deleteMany();
      await db.budgetReservationRecord.deleteMany({ where: { eventId } });
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

  it('emergency release revokes false routes and releases quarantines and decoys atomically', async () => {
    const repository = new AutonomousWorkflowRepository(db);

    const [decoy, route, quarantine] = await Promise.all([
      repository.createDecoyLease({
        eventId,
        templateName: 'mock-admin-decoy-emergency',
        imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
      repository.createFalseRouteLease({
        eventId,
        sourceIp: '198.51.100.99',
        assignedRoute: 'mock-admin-decoy-emergency',
      }),
      repository.createQuarantineLease({
        eventId,
        sourceCidr: '198.51.100.99/32',
      }),
    ]);

    expect(decoy.leaseStatus).toBe('ACTIVE');
    expect(route.leaseStatus).toBe('ACTIVE');
    expect(quarantine.leaseStatus).toBe('ACTIVE');

    const claimResult = await repository.claimEmergencyRelease({
      idempotencyKey: `em-rel-test-${randomUUID()}`,
      principalId: 'operator-emergency-test',
      reason: 'Operator requested emergency release for containment safety',
      correlationId: 'corr-em-01',
    });

    expect(claimResult.isDuplicate).toBe(false);
    if (claimResult.isDuplicate) throw new Error('Expected new claim');
    expect(claimResult.claimedRoutes.length).toBeGreaterThanOrEqual(1);
    expect(claimResult.claimedQuarantines.length).toBeGreaterThanOrEqual(1);
    expect(claimResult.claimedDecoys.length).toBeGreaterThanOrEqual(1);
    expect(claimResult.record.status).toBe('PENDING');

    // Settle route and quarantine releases outside transaction
    for (const r of claimResult.claimedRoutes) {
      await repository.markEmergencyRouteReleased({
        leaseId: r.id,
        emergencyOwnerToken: claimResult.emergencyOwnerToken,
        fencingToken: r.fencingToken,
        success: true,
      });
    }

    for (const q of claimResult.claimedQuarantines) {
      await repository.markEmergencyQuarantineReleased({
        leaseId: q.id,
        emergencyOwnerToken: claimResult.emergencyOwnerToken,
        fencingToken: q.fencingToken,
        success: true,
      });
    }

    await repository.completeEmergencyReleaseRecord({
      recordId: claimResult.record.id,
      verifiedCount: claimResult.claimedRoutes.length + claimResult.claimedQuarantines.length,
      pendingCount: claimResult.claimedDecoys.length,
      failedCount: 0,
      status: 'COMPLETED',
    });

    // Verify in database that leases have desired/observed states updated
    const [updatedDecoy, updatedRoute, updatedQuarantine, updatedRecord] = await Promise.all([
      db.decoyDeploymentLease.findUniqueOrThrow({ where: { id: decoy.id } }),
      db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } }),
      db.quarantineLease.findUniqueOrThrow({ where: { id: quarantine.id } }),
      db.emergencyReleaseRecord.findUniqueOrThrow({ where: { id: claimResult.record.id } }),
    ]);

    expect(updatedDecoy.leaseStatus).toBe('PENDING_CLEANUP');
    expect(updatedDecoy.desiredState).toBe('CLEANUP_PENDING');
    expect(updatedRoute.leaseStatus).toBe('REVOKED');
    expect(updatedRoute.observedState).toBe('REVOKED');
    expect(updatedQuarantine.leaseStatus).toBe('CLEANED_UP');
    expect(updatedQuarantine.observedState).toBe('RELEASED');
    expect(updatedRecord.status).toBe('COMPLETED');
    expect(updatedRecord.verifiedCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects provider intent updates lacking claim token or reconciliation claim CAS', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-fencing-${randomUUID()}`;

    // Claim provider intent
    const claim = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-primary',
    });
    expect(claim.disposition).toBe('CLAIMED');
    if (!claim.claimToken) throw new Error('Expected claim token');

    // 1. Rejects update without claimToken and without reconciliationClaim
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({} as any),
        status: 'EXECUTED',
      }),
    ).rejects.toThrow(
      'updateProviderIntentStatus requires either a claimToken or an explicit reconciliationClaim',
    );

    // 2. Rejects update with stale/wrong claimToken
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        claimToken: randomUUID(),
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    // 2b. Rejects update with malformed claimToken
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        claimToken: 'not-a-valid-uuid',
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    // 3. Accepts update with valid claimToken
    const executed = await repository.updateProviderIntentStatus({
      idempotencyKey,
      claimToken: claim.claimToken,
      status: 'EXECUTED',
      result: { providerResourceId: 'cr-test-1' },
    });
    expect(executed.status).toBe('EXECUTED');
  });

  it('serializes concurrent cleanup sweep lock acquisitions mutually exclusively', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const token1 = `sweep-${randomUUID()}`;
    const token2 = `sweep-${randomUUID()}`;

    const [res1, res2] = await Promise.all([
      repository.acquireCleanupSweepLock({ sweepOwnerToken: token1, ttlMs: 10_000 }),
      repository.acquireCleanupSweepLock({ sweepOwnerToken: token2, ttlMs: 10_000 }),
    ]);

    const acquired = [res1, res2].filter((r) => r.acquired);
    const rejected = [res1, res2].filter((r) => !r.acquired);

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('Active cleanup sweep lock is already held');
  });

  it('prevents second worker from reconciling or overwriting an active unexpired provider intent claim', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-claim-protect-${randomUUID()}`;

    // Worker 1 claims intent with 60s TTL
    const claim1 = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-primary-1',
      claimTtlMs: 60_000,
    });
    expect(claim1.disposition).toBe('CLAIMED');

    // Worker 2 attempts reconciliation on active unexpired claim held by worker 1
    // 1. Reconciliation requiring expired claim must fail CAS
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim1.intent.version,
          expectedOwner: 'worker-primary-1',
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-impostor' },
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    // 2. Reconciliation with wrong expected owner must fail CAS
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim1.intent.version,
          expectedOwner: 'worker-impostor-2',
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-impostor' },
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    // 3. Legitimate worker 1 with claimToken succeeds
    const executed = await repository.updateProviderIntentStatus({
      idempotencyKey,
      claimToken: claim1.claimToken!,
      status: 'EXECUTED',
      result: { providerResourceId: 'cr-legitimate' },
    });
    expect(executed.status).toBe('EXECUTED');
  });

  it('refuses same-worker takeover of an active claim and admits only one concurrent transition to EXECUTED', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-same-worker-${randomUUID()}`;
    const sharedWorkerId = 'worker-shared-process';

    const claim = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: sharedWorkerId,
      claimTtlMs: 60_000,
    });
    expect(claim.disposition).toBe('CLAIMED');

    // A matching worker id is not proof of ownership: a second request in the same process must
    // not be able to reconcile an active claim it does not hold the token for.
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim.intent.version,
          expectedOwner: sharedWorkerId,
          requireExpired: false,
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-same-worker-bypass' },
      }),
    ).rejects.toThrow('requires the original claim token or an expired claim');

    // Even asking for the expiry fence honestly fails while the claim is live.
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim.intent.version,
          expectedOwner: sharedWorkerId,
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-same-worker-bypass' },
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    // Reconciliation without a version fence is refused outright.
    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: { expectedStatus: 'PENDING' },
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('reconciliation requires an expected version fence');

    const settlements = await Promise.allSettled([
      repository.updateProviderIntentStatus({
        idempotencyKey,
        claimToken: claim.claimToken!,
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-race-a' },
      }),
      repository.updateProviderIntentStatus({
        idempotencyKey,
        claimToken: claim.claimToken!,
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-race-b' },
      }),
    ]);
    expect(settlements.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settlements.filter((s) => s.status === 'rejected')).toHaveLength(1);

    const stored = await db.providerIntentRecord.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(stored.status).toBe('EXECUTED');
  });

  it('reconciles an expired provider intent claim and rejects stale versions and wrong claim tokens', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const idempotencyKey = `idem-expired-claim-${randomUUID()}`;

    const claim = await repository.claimProviderIntent({
      idempotencyKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-crashed',
      claimTtlMs: 1,
    });
    expect(claim.disposition).toBe('CLAIMED');
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        claimToken: randomUUID(),
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: (claim.intent.version ?? 0) + 42,
          expectedOwner: 'worker-crashed',
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    await expect(
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim.intent.version,
          expectedOwner: 'worker-never-owned-this',
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
      }),
    ).rejects.toThrow('Provider-intent claim was lost');

    const takeovers = await Promise.allSettled([
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim.intent.version,
          expectedOwner: 'worker-crashed',
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-recovered-a' },
      }),
      repository.updateProviderIntentStatus({
        idempotencyKey,
        reconciliationClaim: {
          expectedStatus: 'CLAIMED',
          expectedVersion: claim.intent.version,
          expectedOwner: 'worker-crashed',
          requireExpired: true,
          asOf: new Date(),
        },
        status: 'EXECUTED',
        result: { providerResourceId: 'cr-recovered-b' },
      }),
    ]);
    expect(takeovers.filter((t) => t.status === 'fulfilled')).toHaveLength(1);

    const stored = await db.providerIntentRecord.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(stored.status).toBe('EXECUTED');
    expect(stored.claimExpiresAt).toBeNull();
  });

  it('settles an ambiguous tool budget reservation for a previous owner only under full fencing', async () => {
    const repository = new AutonomousWorkflowRepository(db);
    const suffix = randomUUID();
    const operationKey = `idem-ambiguous-op-${suffix}`;
    const reservationKey = `budget:tool:${operationKey}`;

    await repository.reserveToolOperation({
      idempotencyKey: operationKey,
      eventId,
      toolName: 'request_decoy_deployment',
      input: { templateName: 'mock-admin-decoy' },
      authorized: true,
      policyReason: 'Synthetic ambiguity fixture',
    });
    const reserved = await repository.reserveBudget({
      idempotencyKey: reservationKey,
      category: 'HOURLY_TOOL_OPERATIONS',
      windowKey: `ambiguity-${suffix}`,
      amountReserved: 1,
      limit: 50,
      ownerId: 'worker-dead-process',
      eventId,
    });
    if (!reserved.granted) throw new Error('Expected the fixture reservation to be granted');

    const settleArgs = {
      reservationKey,
      toolOperationKey: operationKey,
      providerIntentKey: operationKey,
      expectedOwnerId: 'worker-dead-process',
      expectedVersion: reserved.reservation.version,
      settlement: 'RECONCILE' as const,
    };

    expect(
      await repository.settleAmbiguousToolReservation({
        ...settleArgs,
        providerIntentKey: `idem-another-operation-${suffix}`,
      }),
    ).toEqual({ settled: false, reason: 'PROVIDER_INTENT_IDENTITY_MISMATCH' });
    expect(
      await repository.settleAmbiguousToolReservation({
        ...settleArgs,
        reservationKey: `budget:tool:idem-another-operation-${suffix}`,
      }),
    ).toEqual({ settled: false, reason: 'PROVIDER_INTENT_IDENTITY_MISMATCH' });

    // No durable provider intent yet: the ambiguity settlement must refuse.
    expect(await repository.settleAmbiguousToolReservation(settleArgs)).toEqual({
      settled: false,
      reason: 'PROVIDER_INTENT_NOT_EXECUTED',
    });

    const claim = await repository.claimProviderIntent({
      idempotencyKey: operationKey,
      eventId,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-dead-process',
    });
    await repository.updateProviderIntentStatus({
      idempotencyKey: operationKey,
      claimToken: claim.claimToken!,
      status: 'EXECUTED',
      result: { providerResourceId: 'cr-ambiguous-1' },
    });

    expect(
      await repository.settleAmbiguousToolReservation({
        ...settleArgs,
        expectedOwnerId: 'worker-guessing',
      }),
    ).toEqual({ settled: false, reason: 'STALE_RESERVATION_OWNER' });

    expect(
      await repository.settleAmbiguousToolReservation({ ...settleArgs, expectedVersion: 999 }),
    ).toEqual({ settled: false, reason: 'STALE_RESERVATION_VERSION' });

    expect(
      await repository.settleAmbiguousToolReservation({ ...settleArgs, settlement: 'RELEASE' }),
    ).toEqual({ settled: false, reason: 'PROVIDER_INTENT_NOT_FAILED' });

    // Strict stale-owner protection on the normal settlement paths is unchanged.
    await expect(
      repository.consumeBudget({
        idempotencyKey: reservationKey,
        ownerId: 'worker-new-process',
        amountConsumed: 1,
      }),
    ).rejects.toThrow('Stale reservation owner');
    await expect(
      repository.releaseBudget({ idempotencyKey: reservationKey, ownerId: 'worker-new-process' }),
    ).rejects.toThrow('Stale reservation owner');

    const races = await Promise.all([
      repository.settleAmbiguousToolReservation(settleArgs),
      repository.settleAmbiguousToolReservation(settleArgs),
    ]);
    expect(races.filter((r) => r.settled && r.reason === 'RECONCILE')).toHaveLength(1);

    const settled = await db.budgetReservationRecord.findUniqueOrThrow({
      where: { idempotencyKey: reservationKey },
    });
    expect(settled.status).toBe('RECONCILED');
    expect(settled.amountConsumed?.toNumber()).toBe(1);
    expect(settled.ownerId).toBe('worker-dead-process');

    const typeMismatchKey = `idem-type-mismatch-${suffix}`;
    await repository.reserveToolOperation({
      idempotencyKey: typeMismatchKey,
      eventId,
      toolName: 'request_decoy_deployment',
      input: { templateName: 'mock-admin-decoy' },
      authorized: true,
      policyReason: 'Operation-type identity fixture',
    });
    const typeMismatchReservation = await repository.reserveBudget({
      idempotencyKey: `budget:tool:${typeMismatchKey}`,
      category: 'HOURLY_TOOL_OPERATIONS',
      windowKey: `type-mismatch-${suffix}`,
      amountReserved: 1,
      limit: 50,
      ownerId: 'worker-type-mismatch',
      eventId,
    });
    if (!typeMismatchReservation.granted) throw new Error('Expected type mismatch reservation');
    const typeMismatchClaim = await repository.claimProviderIntent({
      idempotencyKey: typeMismatchKey,
      eventId,
      operationType: 'request_source_quarantine',
      provider: 'CLOUD_ARMOR',
      claimOwner: 'worker-type-mismatch',
    });
    await repository.updateProviderIntentStatus({
      idempotencyKey: typeMismatchKey,
      claimToken: typeMismatchClaim.claimToken!,
      status: 'EXECUTED',
      result: { providerResourceId: 'ca-type-mismatch' },
    });
    expect(
      await repository.settleAmbiguousToolReservation({
        reservationKey: `budget:tool:${typeMismatchKey}`,
        toolOperationKey: typeMismatchKey,
        providerIntentKey: typeMismatchKey,
        expectedOwnerId: 'worker-type-mismatch',
        expectedVersion: typeMismatchReservation.reservation.version,
        settlement: 'RECONCILE',
      }),
    ).toEqual({ settled: false, reason: 'PROVIDER_INTENT_IDENTITY_MISMATCH' });

    // Once the operation is terminal the ambiguity path is closed for good.
    await repository.updateToolOperationStage({
      idempotencyKey: operationKey,
      stage: 'FAKE_EXECUTED',
      expectedPriorStage: ['AUTHORIZED', 'FAILED'],
      observedState: 'READY',
    });
    const terminalReservationKey = `budget:usd:${operationKey}`;
    const terminalReserved = await repository.reserveBudget({
      idempotencyKey: terminalReservationKey,
      category: 'HOURLY_TOOL_OPERATIONS',
      windowKey: `ambiguity-${suffix}`,
      amountReserved: 1,
      limit: 50,
      ownerId: 'worker-dead-process',
      eventId,
    });
    if (!terminalReserved.granted) throw new Error('Expected the terminal fixture reservation');
    expect(
      await repository.settleAmbiguousToolReservation({
        ...settleArgs,
        reservationKey: terminalReservationKey,
        expectedVersion: terminalReserved.reservation.version,
      }),
    ).toEqual({ settled: false, reason: 'TOOL_OPERATION_NOT_AMBIGUOUS_FAKE_EXECUTED' });
  });
});
