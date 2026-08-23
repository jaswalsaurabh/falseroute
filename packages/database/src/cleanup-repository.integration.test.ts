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

describe('Cleanup repository recovery and emergency handoff', () => {
  let db: DatabaseClient;
  let repo: AutonomousWorkflowRepository;
  let eventId: string;

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
        correlationId: `corr-cleanup-${randomUUID()}`,
        sourceIp: '198.51.100.210',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 1,
        riskIndicators: ['synthetic_cleanup_test'],
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
      await db.falseRouteLease.deleteMany();
      await db.quarantineLease.deleteMany();
      await db.decoyDeploymentLease.deleteMany();
      await db.intrusionEvent.deleteMany({ where: { id: eventId } });
      await db.$disconnect();
    }
  });

  it('stops claiming a lease after cleanup retries reach TERMINAL_FAILURE', async () => {
    const route = await repo.createFalseRouteLease({
      eventId,
      sourceIp: '198.51.100.211',
      assignedRoute: 'mock-admin-decoy',
    });
    const asOf = new Date(Date.now() + 600_000);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const ownerId = `cleanup-retry-${attempt}`;
      const claimed = await repo.claimLeasesForCleanup({ sweepOwnerToken: ownerId, asOf });
      const claimedRoute = claimed.claimedRoutes.find((candidate) => candidate.id === route.id);
      if (!claimedRoute) throw new Error(`Expected cleanup claim for attempt ${attempt}`);

      await repo.recordLeaseCleanupFailure({
        leaseId: route.id,
        kind: 'FALSE_ROUTE',
        error: `Synthetic provider failure ${attempt}`,
        ownerId,
        fencingToken: claimedRoute.fencingToken,
        maxAttempts: 3,
      });

      const stored = await db.falseRouteLease.findUniqueOrThrow({ where: { id: route.id } });
      expect(stored.cleanupAttempts).toBe(attempt);
      expect(stored.leaseStatus).toBe(attempt === 3 ? 'TERMINAL_FAILURE' : 'CLEANUP_PENDING');
    }

    const exhausted = await repo.claimLeasesForCleanup({
      sweepOwnerToken: 'cleanup-after-exhaustion',
      asOf,
    });
    expect(exhausted.claimedRoutes.map((candidate) => candidate.id)).not.toContain(route.id);

    const ownershipKeys = await repo.findLeaseOwnershipKeys();
    expect(
      ownershipKeys.routeOperationKeys.has(`idem-request_false_route_assignment-${eventId}`),
    ).toBe(true);
  });

  it('hands emergency-deferred leases to cleanup and derives completion from persisted state', async () => {
    await Promise.all([
      repo.createFalseRouteLease({
        eventId,
        sourceIp: '198.51.100.212',
        assignedRoute: 'mock-admin-decoy',
      }),
      repo.createQuarantineLease({ eventId, sourceCidr: '198.51.100.213/32' }),
      repo.createDecoyLease({
        eventId,
        templateName: `mock-admin-decoy-${randomUUID()}`,
        imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ]);

    const emergencyKey = `cleanup-handoff-${randomUUID()}`;
    const emergency = await repo.claimEmergencyRelease({
      idempotencyKey: emergencyKey,
      principalId: 'operator-cleanup-integration',
      reason: 'Synthetic emergency cleanup handoff verification',
      correlationId: `corr-cleanup-handoff-${randomUUID()}`,
    });
    if (emergency.isDuplicate) throw new Error('Expected a new emergency release claim');
    const route = emergency.claimedRoutes[0];
    const quarantine = emergency.claimedQuarantines[0];
    if (!route || !quarantine || emergency.claimedDecoys.length !== 1) {
      throw new Error('Expected one route, quarantine, and decoy claim');
    }

    await Promise.all([
      repo.markEmergencyRouteReleased({
        leaseId: route.id,
        emergencyOwnerToken: emergency.emergencyOwnerToken,
        fencingToken: route.fencingToken,
        success: false,
        deferToCleanup: true,
      }),
      repo.markEmergencyQuarantineReleased({
        leaseId: quarantine.id,
        emergencyOwnerToken: emergency.emergencyOwnerToken,
        fencingToken: quarantine.fencingToken,
        success: false,
        deferToCleanup: true,
      }),
    ]);

    const pending = await repo.settleEmergencyReleaseRecord({
      recordId: emergency.record.id,
      emergencyOwnerToken: emergency.emergencyOwnerToken,
    });
    expect(pending.status).toBe('PENDING');
    expect(pending.pendingCount).toBe(3);

    const sweepOwnerToken = `cleanup-handoff-sweep-${randomUUID()}`;
    const claimed = await repo.claimLeasesForCleanup({ sweepOwnerToken });
    expect(claimed.claimedRoutes).toHaveLength(1);
    expect(claimed.claimedQuarantines).toHaveLength(1);
    expect(claimed.claimedDecoys).toHaveLength(1);

    await Promise.all([
      repo.markRouteRevoked({
        leaseId: claimed.claimedRoutes[0]!.id,
        ownerId: sweepOwnerToken,
        fencingToken: claimed.claimedRoutes[0]!.fencingToken,
      }),
      repo.markQuarantineReleased({
        leaseId: claimed.claimedQuarantines[0]!.id,
        ownerId: sweepOwnerToken,
        fencingToken: claimed.claimedQuarantines[0]!.fencingToken,
      }),
      repo.markDecoyCleanedUp({
        leaseId: claimed.claimedDecoys[0]!.id,
        ownerId: sweepOwnerToken,
        fencingToken: claimed.claimedDecoys[0]!.fencingToken,
      }),
    ]);

    const reconciliation = await repo.claimEmergencyRelease({
      idempotencyKey: emergencyKey,
      principalId: 'operator-cleanup-integration',
      reason: 'Synthetic emergency cleanup handoff verification',
      correlationId: `corr-cleanup-handoff-${randomUUID()}`,
    });
    if (reconciliation.isDuplicate) throw new Error('Expected a reconciliation claim');

    const completed = await repo.settleEmergencyReleaseRecord({
      recordId: emergency.record.id,
      emergencyOwnerToken: reconciliation.emergencyOwnerToken,
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.requestedCount).toBe(3);
    expect(completed.verifiedCount).toBe(3);
    expect(completed.pendingCount).toBe(0);
    expect(completed.failedCount).toBe(0);
  });
});
