import { randomUUID } from 'node:crypto';
import {
  type PrismaClient,
  type EmergencyReleaseRecord,
  Prisma,
} from '../generated/client/client.js';
import { BudgetRepository } from './budget-repository.js';
import {
  deriveEmergencyReleaseStatus,
  summarizeEmergencyLeases,
  type EmergencyLeaseState,
  type EmergencyReleaseCounts,
} from './unsettled-leases.js';

export type EmergencyReleaseClaimResult =
  | {
      isDuplicate: true;
      record: EmergencyReleaseRecord;
      claimedRoutes: never[];
      claimedQuarantines: never[];
      claimedDecoys: never[];
      emergencyOwnerToken?: string;
    }
  | {
      isDuplicate: false;
      record: EmergencyReleaseRecord;
      claimedRoutes: Array<{
        id: string;
        eventId: string;
        sourceIp: string;
        fencingToken: number;
      }>;
      claimedQuarantines: Array<{
        id: string;
        eventId: string;
        sourceCidr: string;
        fencingToken: number;
      }>;
      claimedDecoys: Array<{ id: string; eventId: string; fencingToken: number }>;
      emergencyOwnerToken: string;
    };

interface ClaimedLeaseIds {
  routes: string[];
  quarantines: string[];
  decoys: string[];
}

const ROUTE_SETTLEABLE_STATUSES = ['ACTIVE', 'EMERGENCY_RELEASE_PENDING', 'PENDING_RELEASE'];
const DEFAULT_EMERGENCY_CLAIM_TTL_MS = 60_000;

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * The emergency operation's lease membership is durable in `details` so counters can be derived
 * from real lease state even after cleanup takes ownership of a lease.
 */
function readClaimedLeaseIds(details: Prisma.JsonValue | null | undefined): ClaimedLeaseIds {
  const container =
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? ((details as Record<string, unknown>).claimedLeaseIds as
          Record<string, unknown> | undefined)
      : undefined;
  return {
    routes: readStringArray(container?.routes),
    quarantines: readStringArray(container?.quarantines),
    decoys: readStringArray(container?.decoys),
  };
}

function mergeIds(previous: readonly string[], next: readonly string[]): string[] {
  return Array.from(new Set([...previous, ...next]));
}

function assertCountsConsistent(record: {
  requestedCount: number;
  verifiedCount: number;
  pendingCount: number;
  failedCount: number;
  status: string;
}): void {
  const settled = record.verifiedCount + record.pendingCount + record.failedCount;
  if (record.status === 'COMPLETED' && settled !== record.requestedCount) {
    throw new Error(
      `Emergency release counter invariant violated: requested ${record.requestedCount} !== verified+pending+failed ${settled}`,
    );
  }
}

export class EmergencyReleaseRepository extends BudgetRepository {
  constructor(protected readonly emergencyPrisma: PrismaClient) {
    super(emergencyPrisma);
  }

  async claimEmergencyRelease(params: {
    idempotencyKey: string;
    principalId: string;
    reason: string;
    correlationId: string;
  }): Promise<EmergencyReleaseClaimResult> {
    const emergencyOwnerToken = `emergency-${randomUUID()}`;

    return this.emergencyPrisma.$transaction(async (tx) => {
      // Serialize emergency claims and settlement so lease membership cannot change mid-derivation
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('emergency-release'))
      `;

      const existing = await tx.emergencyReleaseRecord.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      const now = new Date();

      if (existing) {
        if (existing.principalId !== params.principalId || existing.reason !== params.reason) {
          throw new Error('Emergency release idempotency collision with mismatched parameters');
        }

        if (existing.status === 'COMPLETED') {
          return {
            isDuplicate: true as const,
            record: existing,
            claimedRoutes: [],
            claimedQuarantines: [],
            claimedDecoys: [],
          };
        }

        if (existing.claimExpiresAt !== null && existing.claimExpiresAt > now) {
          return {
            isDuplicate: true as const,
            record: existing,
            claimedRoutes: [],
            claimedQuarantines: [],
            claimedDecoys: [],
          };
        }
      }

      const conflictingOperation = await tx.emergencyReleaseRecord.findFirst({
        where: {
          status: { not: 'COMPLETED' },
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        select: { id: true },
      });
      if (conflictingOperation) {
        throw new Error('Another emergency release operation is unfinished');
      }

      const previousIds = readClaimedLeaseIds(existing?.details);
      const previousOwner = existing?.claimOwner;
      const routeResumeFilter =
        existing && previousOwner
          ? {
              id: { in: previousIds.routes },
              ownerId: previousOwner,
              leaseStatus: { in: ROUTE_SETTLEABLE_STATUSES },
            }
          : undefined;
      const quarantineResumeFilter =
        existing && previousOwner
          ? {
              id: { in: previousIds.quarantines },
              ownerId: previousOwner,
              leaseStatus: { in: ROUTE_SETTLEABLE_STATUSES },
            }
          : undefined;
      const decoyResumeFilter =
        existing && previousOwner
          ? {
              id: { in: previousIds.decoys },
              ownerId: previousOwner,
              leaseStatus: { in: ['PENDING_CLEANUP', 'CLEANUP_PENDING'] },
            }
          : undefined;

      // Candidate leases: anything still active anywhere, plus unsettled work already owned by
      // this emergency operation (a resumed retry must pick up its own leftovers).
      const [candidateRoutes, candidateQuarantines, candidateDecoys] = await Promise.all([
        tx.falseRouteLease.findMany({
          where: {
            OR: [{ leaseStatus: 'ACTIVE' }, ...(routeResumeFilter ? [routeResumeFilter] : [])],
          },
        }),
        tx.quarantineLease.findMany({
          where: {
            OR: [
              { leaseStatus: 'ACTIVE' },
              ...(quarantineResumeFilter ? [quarantineResumeFilter] : []),
            ],
          },
        }),
        tx.decoyDeploymentLease.findMany({
          where: {
            OR: [{ leaseStatus: 'ACTIVE' }, ...(decoyResumeFilter ? [decoyResumeFilter] : [])],
          },
        }),
      ]);

      const claimedRoutes = await Promise.all(
        candidateRoutes.map((r) =>
          tx.falseRouteLease.update({
            where: { id: r.id, version: r.version },
            data: {
              desiredState: 'REVOKED',
              leaseStatus: 'EMERGENCY_RELEASE_PENDING',
              ownerId: emergencyOwnerToken,
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      const claimedQuarantines = await Promise.all(
        candidateQuarantines.map((q) =>
          tx.quarantineLease.update({
            where: { id: q.id, version: q.version },
            data: {
              desiredState: 'RELEASED',
              leaseStatus: 'EMERGENCY_RELEASE_PENDING',
              ownerId: emergencyOwnerToken,
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      const claimedDecoys = await Promise.all(
        candidateDecoys.map((d) =>
          tx.decoyDeploymentLease.update({
            where: { id: d.id, version: d.version },
            data: {
              desiredState: 'CLEANUP_PENDING',
              leaseStatus: 'PENDING_CLEANUP',
              expiresAt: new Date(0), // Immediately eligible for cleanup sweep
              ownerId: emergencyOwnerToken,
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      const claimedLeaseIds: ClaimedLeaseIds = {
        routes: mergeIds(
          previousIds.routes,
          claimedRoutes.map((r) => r.id),
        ),
        quarantines: mergeIds(
          previousIds.quarantines,
          claimedQuarantines.map((q) => q.id),
        ),
        decoys: mergeIds(
          previousIds.decoys,
          claimedDecoys.map((d) => d.id),
        ),
      };
      const requestedCount =
        claimedLeaseIds.routes.length +
        claimedLeaseIds.quarantines.length +
        claimedLeaseIds.decoys.length;
      const details = { claimedLeaseIds } as unknown as Prisma.InputJsonValue;
      const claimExpiresAt = new Date(now.getTime() + DEFAULT_EMERGENCY_CLAIM_TTL_MS);

      const record = existing
        ? await tx.emergencyReleaseRecord.update({
            where: { id: existing.id },
            data: {
              requestedCount,
              details,
              status: 'PENDING',
              claimOwner: emergencyOwnerToken,
              claimExpiresAt,
              version: { increment: 1 },
            },
          })
        : await tx.emergencyReleaseRecord.create({
            data: {
              idempotencyKey: params.idempotencyKey,
              principalId: params.principalId,
              reason: params.reason,
              correlationId: params.correlationId,
              status: 'PENDING',
              requestedCount,
              verifiedCount: 0,
              pendingCount: claimedDecoys.length,
              failedCount: 0,
              details,
              claimOwner: emergencyOwnerToken,
              claimExpiresAt,
            },
          });

      return {
        isDuplicate: false as const,
        record,
        claimedRoutes: claimedRoutes.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          sourceIp: r.sourceIp,
          fencingToken: r.fencingToken,
        })),
        claimedQuarantines: claimedQuarantines.map((q) => ({
          id: q.id,
          eventId: q.eventId,
          sourceCidr: q.sourceCidr,
          fencingToken: q.fencingToken,
        })),
        claimedDecoys: claimedDecoys.map((d) => ({
          id: d.id,
          eventId: d.eventId,
          fencingToken: d.fencingToken,
        })),
        emergencyOwnerToken,
      };
    });
  }

  async markEmergencyRouteReleased(params: {
    leaseId: string;
    emergencyOwnerToken: string;
    fencingToken: number;
    success: boolean;
    /** Leaves the lease unsettled but immediately eligible for the worker cleanup sweep. */
    deferToCleanup?: boolean;
  }) {
    const where = {
      id: params.leaseId,
      ownerId: params.emergencyOwnerToken,
      fencingToken: params.fencingToken,
      leaseStatus: { in: ROUTE_SETTLEABLE_STATUSES },
    };

    if (params.success) {
      return this.emergencyPrisma.falseRouteLease.updateMany({
        where,
        data: {
          leaseStatus: 'REVOKED',
          observedState: 'REVOKED',
          revokedAt: new Date(),
          version: { increment: 1 },
        },
      });
    }

    if (params.deferToCleanup) {
      return this.emergencyPrisma.falseRouteLease.updateMany({
        where,
        data: { expiresAt: new Date(0), version: { increment: 1 } },
      });
    }

    // A failed emergency release must not wait for the original TTL; owner and fencing token are
    // preserved so a stale cleanup worker still loses the compare-and-set.
    return this.emergencyPrisma.falseRouteLease.updateMany({
      where,
      data: {
        lastFailureReason: 'Emergency route revocation failed during adapter settlement',
        cleanupAttempts: { increment: 1 },
        expiresAt: new Date(0),
        version: { increment: 1 },
      },
    });
  }

  async markEmergencyQuarantineReleased(params: {
    leaseId: string;
    emergencyOwnerToken: string;
    fencingToken: number;
    success: boolean;
    /** Leaves the lease unsettled but immediately eligible for the worker cleanup sweep. */
    deferToCleanup?: boolean;
  }) {
    const where = {
      id: params.leaseId,
      ownerId: params.emergencyOwnerToken,
      fencingToken: params.fencingToken,
      leaseStatus: { in: ROUTE_SETTLEABLE_STATUSES },
    };

    if (params.success) {
      return this.emergencyPrisma.quarantineLease.updateMany({
        where,
        data: {
          leaseStatus: 'CLEANED_UP',
          observedState: 'RELEASED',
          releasedAt: new Date(),
          version: { increment: 1 },
        },
      });
    }

    if (params.deferToCleanup) {
      return this.emergencyPrisma.quarantineLease.updateMany({
        where,
        data: { expiresAt: new Date(0), version: { increment: 1 } },
      });
    }

    return this.emergencyPrisma.quarantineLease.updateMany({
      where,
      data: {
        lastFailureReason: 'Emergency quarantine release failed during adapter settlement',
        cleanupAttempts: { increment: 1 },
        expiresAt: new Date(0),
        version: { increment: 1 },
      },
    });
  }

  /**
   * Derives the record's counters from the durable state of every lease this emergency operation
   * ever claimed. Attempt-local numbers are never written, so a retry cannot overwrite an earlier
   * successful or failed outcome and the counter invariant cannot be violated.
   */
  async settleEmergencyReleaseRecord(params: {
    recordId: string;
    emergencyOwnerToken: string;
  }): Promise<EmergencyReleaseRecord & { derivedCounts: EmergencyReleaseCounts }> {
    const settled = await this.emergencyPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('emergency-release'))
      `;

      const record = await tx.emergencyReleaseRecord.findUniqueOrThrow({
        where: { id: params.recordId },
      });
      if (
        record.claimOwner !== params.emergencyOwnerToken ||
        record.claimExpiresAt === null ||
        record.claimExpiresAt <= new Date()
      ) {
        throw new Error('Emergency release record settlement fence was lost');
      }
      const ids = readClaimedLeaseIds(record.details);

      const [routes, quarantines, decoys] = await Promise.all([
        tx.falseRouteLease.findMany({
          where: { id: { in: ids.routes } },
          select: { leaseStatus: true, lastFailureReason: true },
        }),
        tx.quarantineLease.findMany({
          where: { id: { in: ids.quarantines } },
          select: { leaseStatus: true, lastFailureReason: true },
        }),
        tx.decoyDeploymentLease.findMany({
          where: { id: { in: ids.decoys } },
          select: { leaseStatus: true, lastFailureReason: true },
        }),
      ]);

      const states: EmergencyLeaseState[] = [
        ...routes.map((r) => ({ kind: 'ROUTE' as const, ...r })),
        ...quarantines.map((q) => ({ kind: 'QUARANTINE' as const, ...q })),
        ...decoys.map((d) => ({ kind: 'DECOY' as const, ...d })),
      ];
      const missing =
        ids.routes.length -
        routes.length +
        (ids.quarantines.length - quarantines.length) +
        (ids.decoys.length - decoys.length);

      const counts = summarizeEmergencyLeases(states, missing);
      const status = deriveEmergencyReleaseStatus(counts);
      assertCountsConsistent({ ...counts, status });

      const updated = await tx.emergencyReleaseRecord.update({
        where: { id: record.id },
        data: {
          requestedCount: counts.requestedCount,
          verifiedCount: counts.verifiedCount,
          pendingCount: counts.pendingCount,
          failedCount: counts.failedCount,
          status,
          completedAt: status === 'COMPLETED' ? new Date() : null,
          claimExpiresAt: null,
        },
      });

      return { updated, counts };
    });

    return { ...settled.updated, derivedCounts: settled.counts };
  }

  async completeEmergencyReleaseRecord(params: {
    recordId: string;
    verifiedCount: number;
    pendingCount: number;
    failedCount: number;
    status: 'COMPLETED' | 'PARTIAL_FAILURE';
    details?: Record<string, unknown>;
  }) {
    const existing = await this.emergencyPrisma.emergencyReleaseRecord.findUniqueOrThrow({
      where: { id: params.recordId },
    });
    assertCountsConsistent({ ...params, requestedCount: existing.requestedCount });

    return this.emergencyPrisma.emergencyReleaseRecord.update({
      where: { id: params.recordId },
      data: {
        verifiedCount: params.verifiedCount,
        pendingCount: params.pendingCount,
        failedCount: params.failedCount,
        status: params.status,
        completedAt: new Date(),
        claimExpiresAt: null,
        ...(params.details !== undefined
          ? { details: params.details as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }
}
