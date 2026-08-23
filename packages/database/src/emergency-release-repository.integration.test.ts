import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('Emergency release durable counters and cleanup eligibility', () => {
  let db: DatabaseClient;
  let repo: AutonomousWorkflowRepository;
  let eventId: string;

  const principalId = 'operator-emergency-integration';
  const reason = 'Operator requested emergency release for containment safety';

  function claim(idempotencyKey: string) {
    return repo.claimEmergencyRelease({
      idempotencyKey,
      principalId,
      reason,
      correlationId: 'corr-em-integration',
    });
  }

  function newRoute(sourceIp: string) {
    return repo.createFalseRouteLease({ eventId, sourceIp, assignedRoute: 'mock-admin-decoy' });
  }

  function newQuarantine(sourceCidr: string) {
    return repo.createQuarantineLease({ eventId, sourceCidr });
  }

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
    repo = new AutonomousWorkflowRepository(db);
    eventId = randomUUID();
    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId: `corr-emergency-${Date.now()}`,
        sourceIp: '198.51.100.200',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 1,
        riskIndicators: ['synthetic_emergency_test'],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: false,
        status: ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });
  });

  beforeEach(async () => {
    await db.emergencyReleaseRecord.deleteMany();
    await db.cleanupSweepRecord.deleteMany();
    await db.falseRouteLease.deleteMany();
    await db.quarantineLease.deleteMany();
    await db.decoyDeploymentLease.deleteMany();
  });

  afterAll(async () => {
    if (db) {
      await db.emergencyReleaseRecord.deleteMany();
      await db.cleanupSweepRecord.deleteMany();
      await db.intrusionEvent.deleteMany({ where: { id: eventId } });
      await db.$disconnect();
    }
  });

  it('accumulates counters across a partial failure and a successful retry', async () => {
    const key = `em-partial-${randomUUID()}`;
    const [routeA, routeB] = await Promise.all([
      newRoute('198.51.100.11'),
      newRoute('198.51.100.12'),
    ]);

    const first = await claim(key);
    if (first.isDuplicate) throw new Error('Expected a new claim');
    expect(first.claimedRoutes).toHaveLength(2);

    for (const route of first.claimedRoutes) {
      await repo.markEmergencyRouteReleased({
        leaseId: route.id,
        emergencyOwnerToken: first.emergencyOwnerToken,
        fencingToken: route.fencingToken,
        success: route.id === routeA.id,
      });
    }

    const partial = await repo.settleEmergencyReleaseRecord({
      recordId: first.record.id,
      emergencyOwnerToken: first.emergencyOwnerToken,
    });
    expect(partial.status).toBe('PARTIAL_FAILURE');
    expect(partial.requestedCount).toBe(2);
    expect(partial.verifiedCount).toBe(1);
    expect(partial.failedCount).toBe(1);
    expect(partial.verifiedCount + partial.pendingCount + partial.failedCount).toBe(
      partial.requestedCount,
    );

    // Retry resumes only the unsettled lease; the already-revoked lease is not re-claimed.
    const retry = await claim(key);
    if (retry.isDuplicate) throw new Error('Expected a resumable claim');
    expect(retry.claimedRoutes.map((r) => r.id)).toEqual([routeB.id]);

    const retriedRoute = retry.claimedRoutes[0];
    if (!retriedRoute) throw new Error('Expected the unsettled route');
    const casResult = await repo.markEmergencyRouteReleased({
      leaseId: retriedRoute.id,
      emergencyOwnerToken: retry.emergencyOwnerToken,
      fencingToken: retriedRoute.fencingToken,
      success: true,
    });
    expect(casResult.count).toBe(1);

    const completed = await repo.settleEmergencyReleaseRecord({
      recordId: first.record.id,
      emergencyOwnerToken: retry.emergencyOwnerToken,
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.requestedCount).toBe(2);
    expect(completed.verifiedCount).toBe(2);
    expect(completed.failedCount).toBe(0);
    expect(completed.verifiedCount + completed.pendingCount + completed.failedCount).toBe(
      completed.requestedCount,
    );

    // The earlier successful outcome was never overwritten.
    const storedA = await db.falseRouteLease.findUniqueOrThrow({ where: { id: routeA.id } });
    expect(storedA.leaseStatus).toBe('REVOKED');
  });

  it('keeps a settlement-persistence failure retryable instead of a false zero-count completion', async () => {
    const key = `em-crash-${randomUUID()}`;
    const route = await newRoute('198.51.100.13');

    const first = await claim(key);
    if (first.isDuplicate) throw new Error('Expected a new claim');
    const claimed = first.claimedRoutes[0];
    if (!claimed) throw new Error('Expected a claimed route');
    await repo.markEmergencyRouteReleased({
      leaseId: claimed.id,
      emergencyOwnerToken: first.emergencyOwnerToken,
      fencingToken: claimed.fencingToken,
      success: true,
    });

    // Simulate a crash before the record was settled: the record must not be COMPLETED.
    const stalled = await db.emergencyReleaseRecord.findUniqueOrThrow({
      where: { id: first.record.id },
    });
    expect(stalled.status).toBe('PENDING');
    expect(stalled.completedAt).toBeNull();

    // Crash recovery becomes eligible only after the prior settlement authority expires.
    await db.emergencyReleaseRecord.update({
      where: { id: first.record.id },
      data: { claimExpiresAt: new Date(0) },
    });

    const retry = await claim(key);
    if (retry.isDuplicate) throw new Error('Expected a resumable claim');
    expect(retry.claimedRoutes).toHaveLength(0);

    const settled = await repo.settleEmergencyReleaseRecord({
      recordId: first.record.id,
      emergencyOwnerToken: retry.emergencyOwnerToken,
    });
    expect(settled.status).toBe('COMPLETED');
    expect(settled.requestedCount).toBe(1);
    expect(settled.verifiedCount).toBe(1);
    expect(settled.pendingCount).toBe(0);
    expect(settled.failedCount).toBe(0);

    const finalRoute = await db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } });
    expect(finalRoute.leaseStatus).toBe('REVOKED');

    // A same-key request against a COMPLETED record is an idempotent replay with stored counters.
    const replay = await claim(key);
    expect(replay.isDuplicate).toBe(true);
    expect(replay.record.verifiedCount).toBe(1);
    expect(replay.record.requestedCount).toBe(1);
  });

  it('absorbs newly active leases into the same unfinished emergency operation', async () => {
    const key = `em-newly-active-${randomUUID()}`;
    await newRoute('198.51.100.14');

    const first = await claim(key);
    if (first.isDuplicate) throw new Error('Expected a new claim');
    const claimed = first.claimedRoutes[0];
    if (!claimed) throw new Error('Expected a claimed route');
    await repo.markEmergencyRouteReleased({
      leaseId: claimed.id,
      emergencyOwnerToken: first.emergencyOwnerToken,
      fencingToken: claimed.fencingToken,
      success: false,
    });
    const partial = await repo.settleEmergencyReleaseRecord({
      recordId: first.record.id,
      emergencyOwnerToken: first.emergencyOwnerToken,
    });
    expect(partial.requestedCount).toBe(1);
    expect(partial.failedCount).toBe(1);

    // A lease created after the first attempt joins the same operation on retry.
    const late = await newRoute('198.51.100.15');
    const retry = await claim(key);
    if (retry.isDuplicate) throw new Error('Expected a resumable claim');
    expect(retry.claimedRoutes.map((r) => r.id)).toContain(late.id);

    for (const route of retry.claimedRoutes) {
      await repo.markEmergencyRouteReleased({
        leaseId: route.id,
        emergencyOwnerToken: retry.emergencyOwnerToken,
        fencingToken: route.fencingToken,
        success: true,
      });
    }

    const settled = await repo.settleEmergencyReleaseRecord({
      recordId: first.record.id,
      emergencyOwnerToken: retry.emergencyOwnerToken,
    });
    expect(settled.requestedCount).toBe(2);
    expect(settled.verifiedCount).toBe(2);
    expect(settled.failedCount).toBe(0);
    expect(settled.status).toBe('COMPLETED');
  });

  it('gives only one same-key concurrent request provider-settlement authority', async () => {
    const key = `em-concurrent-${randomUUID()}`;
    await Promise.all([newRoute('198.51.100.16'), newRoute('198.51.100.17')]);

    const [attemptA, attemptB] = await Promise.all([claim(key), claim(key)]);
    const liveAttempts = [attemptA, attemptB].filter((attempt) => !attempt.isDuplicate);
    const joinedAttempts = [attemptA, attemptB].filter((attempt) => attempt.isDuplicate);
    expect(liveAttempts).toHaveLength(1);
    expect(joinedAttempts).toHaveLength(1);

    const live = liveAttempts[0];
    const joined = joinedAttempts[0];
    if (!live || live.isDuplicate || !joined || !joined.isDuplicate) {
      throw new Error('Expected one live claim and one joined claim');
    }
    expect(live.record.id).toBe(joined.record.id);
    expect(live.claimedRoutes).toHaveLength(2);
    expect(joined.claimedRoutes).toHaveLength(0);

    const records = await db.emergencyReleaseRecord.findMany({ where: { idempotencyKey: key } });
    expect(records).toHaveLength(1);

    const results = await Promise.all(
      live.claimedRoutes.map((route) =>
        repo.markEmergencyRouteReleased({
          leaseId: route.id,
          emergencyOwnerToken: live.emergencyOwnerToken,
          fencingToken: route.fencingToken,
          success: true,
        }),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.count, 0)).toBe(2);

    const settled = await repo.settleEmergencyReleaseRecord({
      recordId: live.record.id,
      emergencyOwnerToken: live.emergencyOwnerToken,
    });
    expect(settled.verifiedCount + settled.pendingCount + settled.failedCount).toBe(
      settled.requestedCount,
    );
    expect(settled.status).toBe('COMPLETED');
    expect(settled.verifiedCount).toBe(2);
  });

  it('fails a different-key request closed while another emergency release is unfinished', async () => {
    await newRoute('198.51.100.23');
    const keyA = `em-conflict-a-${randomUUID()}`;
    const keyB = `em-conflict-b-${randomUUID()}`;

    const results = await Promise.allSettled([claim(keyA), claim(keyB)]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(
      expect.objectContaining({ message: 'Another emergency release operation is unfinished' }),
    );
    expect(fulfilled[0]?.value.isDuplicate).toBe(false);

    const records = await db.emergencyReleaseRecord.findMany({
      where: { idempotencyKey: { in: [keyA, keyB] } },
    });
    expect(records).toHaveLength(1);
  });

  it('re-fences an expired same-key claim before resuming provider settlement', async () => {
    const key = `em-expired-${randomUUID()}`;
    await newRoute('198.51.100.24');

    const first = await repo.claimEmergencyRelease({
      idempotencyKey: key,
      principalId,
      reason,
      correlationId: 'corr-em-integration',
    });
    if (first.isDuplicate) throw new Error('Expected a new claim');
    const firstRoute = first.claimedRoutes[0];
    if (!firstRoute) throw new Error('Expected a claimed route');

    await db.emergencyReleaseRecord.update({
      where: { id: first.record.id },
      data: { claimExpiresAt: new Date(0) },
    });

    const resumed = await claim(key);
    if (resumed.isDuplicate) throw new Error('Expected an expired claim to resume');
    const resumedRoute = resumed.claimedRoutes[0];
    if (!resumedRoute) throw new Error('Expected the route to be re-claimed');
    expect(resumed.emergencyOwnerToken).not.toBe(first.emergencyOwnerToken);
    expect(resumedRoute.fencingToken).toBe(firstRoute.fencingToken + 1);

    const staleResult = await repo.markEmergencyRouteReleased({
      leaseId: firstRoute.id,
      emergencyOwnerToken: first.emergencyOwnerToken,
      fencingToken: firstRoute.fencingToken,
      success: true,
    });
    expect(staleResult.count).toBe(0);

    const currentResult = await repo.markEmergencyRouteReleased({
      leaseId: resumedRoute.id,
      emergencyOwnerToken: resumed.emergencyOwnerToken,
      fencingToken: resumedRoute.fencingToken,
      success: true,
    });
    expect(currentResult.count).toBe(1);

    await expect(
      repo.settleEmergencyReleaseRecord({
        recordId: first.record.id,
        emergencyOwnerToken: first.emergencyOwnerToken,
      }),
    ).rejects.toThrow('Emergency release record settlement fence was lost');

    const third = await claim(key);
    expect(third.isDuplicate).toBe(true);

    const settled = await repo.settleEmergencyReleaseRecord({
      recordId: resumed.record.id,
      emergencyOwnerToken: resumed.emergencyOwnerToken,
    });
    expect(settled.status).toBe('COMPLETED');
    expect(settled.claimExpiresAt).toBeNull();
  });

  it('makes failed route and quarantine releases immediately cleanup-eligible', async () => {
    const key = `em-eligible-${randomUUID()}`;
    await Promise.all([newRoute('198.51.100.18'), newQuarantine('198.51.100.18/32')]);

    const attempt = await claim(key);
    if (attempt.isDuplicate) throw new Error('Expected a new claim');
    const route = attempt.claimedRoutes[0];
    const quarantine = attempt.claimedQuarantines[0];
    if (!route || !quarantine) throw new Error('Expected claimed leases');

    await repo.markEmergencyRouteReleased({
      leaseId: route.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
      fencingToken: route.fencingToken,
      success: false,
    });
    await repo.markEmergencyQuarantineReleased({
      leaseId: quarantine.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
      fencingToken: quarantine.fencingToken,
      success: false,
    });

    const [storedRoute, storedQuarantine] = await Promise.all([
      db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } }),
      db.quarantineLease.findUniqueOrThrow({ where: { id: quarantine.id } }),
    ]);

    for (const lease of [storedRoute, storedQuarantine]) {
      expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(lease.ownerId).toBe(attempt.emergencyOwnerToken);
      expect(lease.leaseStatus).toBe('EMERGENCY_RELEASE_PENDING');
    }
    // Fencing tokens are preserved so ownership authority does not change on failure.
    expect(storedRoute.fencingToken).toBe(route.fencingToken);
    expect(storedQuarantine.fencingToken).toBe(quarantine.fencingToken);

    const claimed = await repo.claimLeasesForCleanup({ sweepOwnerToken: `sweep-${randomUUID()}` });
    expect(claimed.claimedRoutes.map((r) => r.id)).toContain(route.id);
    expect(claimed.claimedQuarantines.map((q) => q.id)).toContain(quarantine.id);
  });

  it('rejects a stale cleanup worker and lets only one owner settle an emergency lease', async () => {
    const key = `em-fencing-${randomUUID()}`;
    await newRoute('198.51.100.19');

    const attempt = await claim(key);
    if (attempt.isDuplicate) throw new Error('Expected a new claim');
    const route = attempt.claimedRoutes[0];
    if (!route) throw new Error('Expected a claimed route');
    await repo.markEmergencyRouteReleased({
      leaseId: route.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
      fencingToken: route.fencingToken,
      success: false,
    });
    await repo.settleEmergencyReleaseRecord({
      recordId: attempt.record.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
    });

    // A cleanup sweep takes the now-eligible lease over, re-fencing it.
    const staleSweep = `sweep-stale-${randomUUID()}`;
    const firstSweep = await repo.claimLeasesForCleanup({ sweepOwnerToken: staleSweep });
    const sweptRoute = firstSweep.claimedRoutes.find((r) => r.id === route.id);
    if (!sweptRoute) throw new Error('Expected the failed route to be cleanup-eligible');

    const freshSweep = `sweep-fresh-${randomUUID()}`;
    const secondSweep = await repo.claimLeasesForCleanup({ sweepOwnerToken: freshSweep });
    const freshRoute = secondSweep.claimedRoutes.find((r) => r.id === route.id);
    if (!freshRoute) throw new Error('Expected the lease to be re-claimed by the fresh sweep');

    // The stale worker's fence was superseded and must be rejected.
    await expect(
      repo.markRouteRevoked({
        leaseId: route.id,
        ownerId: staleSweep,
        fencingToken: sweptRoute.fencingToken,
      }),
    ).rejects.toThrow('False-route lease cleanup fence was lost');

    const current = await db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } });
    expect(current.leaseStatus).not.toBe('REVOKED');

    // An emergency retry must not fight the cleanup owner for the same lease.
    const retry = await claim(key);
    if (retry.isDuplicate) throw new Error('Expected a resumable claim');
    expect(retry.claimedRoutes.map((r) => r.id)).not.toContain(route.id);

    const emergencyAttempt = await repo.markEmergencyRouteReleased({
      leaseId: route.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
      fencingToken: route.fencingToken,
      success: true,
    });
    expect(emergencyAttempt.count).toBe(0);

    // Only the current cleanup owner settles it, exactly once.
    await repo.markRouteRevoked({
      leaseId: route.id,
      ownerId: freshSweep,
      fencingToken: freshRoute.fencingToken,
    });

    const settledOnce = await db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } });
    expect(settledOnce.leaseStatus).toBe('REVOKED');
    expect(settledOnce.revokedAt).not.toBeNull();

    // The emergency record still tracks the lease and reports the cleanup-verified outcome.
    const settledRecord = await repo.settleEmergencyReleaseRecord({
      recordId: attempt.record.id,
      emergencyOwnerToken: retry.emergencyOwnerToken,
    });
    expect(settledRecord.requestedCount).toBe(1);
    expect(settledRecord.verifiedCount).toBe(1);
    expect(settledRecord.failedCount).toBe(0);
    expect(settledRecord.status).toBe('COMPLETED');
  });

  it('leaves decoys pending cleanup while completing route settlement', async () => {
    const key = `em-decoys-${randomUUID()}`;
    await Promise.all([
      newRoute('198.51.100.20'),
      repo.createDecoyLease({
        eventId,
        templateName: `mock-admin-decoy-${randomUUID()}`,
        imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ]);

    const attempt = await claim(key);
    if (attempt.isDuplicate) throw new Error('Expected a new claim');
    const route = attempt.claimedRoutes[0];
    const decoy = attempt.claimedDecoys[0];
    if (!route || !decoy) throw new Error('Expected claimed leases');

    await repo.markEmergencyRouteReleased({
      leaseId: route.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
      fencingToken: route.fencingToken,
      success: true,
    });

    const settled = await repo.settleEmergencyReleaseRecord({
      recordId: attempt.record.id,
      emergencyOwnerToken: attempt.emergencyOwnerToken,
    });
    expect(settled.status).toBe('COMPLETED');
    expect(settled.requestedCount).toBe(2);
    expect(settled.verifiedCount).toBe(1);
    expect(settled.pendingCount).toBe(1);
    expect(settled.failedCount).toBe(0);

    const storedDecoy = await db.decoyDeploymentLease.findUniqueOrThrow({
      where: { id: decoy.id },
    });
    expect(storedDecoy.leaseStatus).toBe('PENDING_CLEANUP');
    expect(storedDecoy.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('refuses to persist a COMPLETED record that violates the counter invariant', async () => {
    const key = `em-invariant-${randomUUID()}`;
    await Promise.all([newRoute('198.51.100.21'), newRoute('198.51.100.22')]);

    const attempt = await claim(key);
    if (attempt.isDuplicate) throw new Error('Expected a new claim');
    expect(attempt.record.requestedCount).toBe(2);

    await expect(
      repo.completeEmergencyReleaseRecord({
        recordId: attempt.record.id,
        verifiedCount: 1,
        pendingCount: 0,
        failedCount: 0,
        status: 'COMPLETED',
      }),
    ).rejects.toThrow('Emergency release counter invariant violated');

    const stored = await db.emergencyReleaseRecord.findUniqueOrThrow({
      where: { id: attempt.record.id },
    });
    expect(stored.status).toBe('PENDING');
  });
});
