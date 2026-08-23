import type { PrismaClient } from '../generated/client/client.js';
import { EmergencyReleaseRepository } from './emergency-release-repository.js';
import type { UnsettledLeasesResult } from './unsettled-leases.js';

export { type UnsettledLeasesResult };

export class LeaseRepository extends EmergencyReleaseRepository {
  constructor(protected readonly leasePrisma: PrismaClient) {
    super(leasePrisma);
  }

  async createDecoyLease(params: {
    eventId: string;
    templateName: string;
    imageDigest: string;
    desiredState?: string;
    observedState?: string;
    serviceUrl?: string;
    healthStatus?: string;
    ttlSeconds?: number;
    ownerId?: string;
  }) {
    const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000);
    const ownershipKey = `decoy:${params.eventId}:${params.templateName}`;
    try {
      return await this.leasePrisma.decoyDeploymentLease.create({
        data: {
          eventId: params.eventId,
          templateName: params.templateName,
          imageDigest: params.imageDigest,
          desiredState: params.desiredState ?? 'READY',
          observedState: params.observedState ?? 'PENDING',
          serviceUrl: params.serviceUrl ?? null,
          healthStatus: params.healthStatus ?? 'UNKNOWN',
          leaseStatus: 'ACTIVE',
          expiresAt,
          ownershipKey,
          ownerId: params.ownerId ?? 'worker-autonomous-01',
          fencingToken: 1,
          version: 1,
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        return this.leasePrisma.decoyDeploymentLease.findUniqueOrThrow({
          where: { ownershipKey },
        });
      }
      throw error;
    }
  }

  async createFalseRouteLease(params: {
    eventId: string;
    sourceIp: string;
    assignedRoute: string;
    ttlSeconds?: number;
    ownerId?: string;
  }) {
    const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000);
    const ownershipKey = `route:${params.eventId}:${params.sourceIp}`;
    try {
      return await this.leasePrisma.falseRouteLease.create({
        data: {
          eventId: params.eventId,
          sourceIp: params.sourceIp,
          assignedRoute: params.assignedRoute,
          desiredState: 'ACTIVE',
          observedState: 'ACTIVE',
          leaseStatus: 'ACTIVE',
          expiresAt,
          ownershipKey,
          ownerId: params.ownerId ?? 'worker-autonomous-01',
          fencingToken: 1,
          version: 1,
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        return this.leasePrisma.falseRouteLease.findUniqueOrThrow({
          where: { ownershipKey },
        });
      }
      throw error;
    }
  }

  async createQuarantineLease(params: {
    eventId: string;
    sourceCidr: string;
    policyName?: string;
    rulePriority?: number;
    ttlSeconds?: number;
    ownerId?: string;
  }) {
    const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 600) * 1000);
    const ownershipKey = `quarantine:${params.eventId}:${params.sourceCidr}`;
    try {
      return await this.leasePrisma.quarantineLease.create({
        data: {
          eventId: params.eventId,
          sourceCidr: params.sourceCidr,
          policyName: params.policyName ?? 'falseroute-quarantine-policy',
          rulePriority: params.rulePriority ?? 1050,
          desiredState: 'ENFORCED',
          observedState: 'ENFORCED',
          leaseStatus: 'ACTIVE',
          expiresAt,
          ownershipKey,
          ownerId: params.ownerId ?? 'worker-autonomous-01',
          fencingToken: 1,
          version: 1,
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        return this.leasePrisma.quarantineLease.findUniqueOrThrow({
          where: { ownershipKey },
        });
      }
      throw error;
    }
  }

  async acquireCleanupSweepLock(params: {
    sweepOwnerToken: string;
    ttlMs?: number;
  }): Promise<{ acquired: boolean; sweepId?: string; reason?: string }> {
    const ttlMs = params.ttlMs ?? 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);

    return this.leasePrisma.$transaction(async (tx) => {
      // 1. Acquire transaction advisory lock to serialize sweep lock acquisitions
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('cleanup-sweep-lock'))
      `;

      // 2. Check if another sweep currently holds an unexpired lock
      const activeSweep = await tx.cleanupSweepRecord.findFirst({
        where: {
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
          sweepOwnerToken: { not: params.sweepOwnerToken },
        },
      });

      if (activeSweep) {
        return {
          acquired: false,
          reason: `Active cleanup sweep lock is already held by token ${activeSweep.sweepOwnerToken}`,
        };
      }

      const created = await tx.cleanupSweepRecord.create({
        data: {
          sweepOwnerToken: params.sweepOwnerToken,
          status: 'ACTIVE',
          expiresAt,
          fencingToken: 1,
        },
      });

      return {
        acquired: true,
        sweepId: created.id,
      };
    });
  }

  async completeCleanupSweepRecord(params: {
    sweepOwnerToken: string;
    cleanedDecoys: number;
    cleanedRoutes: number;
    cleanedQuarantines: number;
    discoveredOrphans: number;
    failures?: Record<string, unknown>[] | undefined;
    status?: string | undefined;
  }) {
    return this.leasePrisma.cleanupSweepRecord.update({
      where: { sweepOwnerToken: params.sweepOwnerToken },
      data: {
        status:
          params.status ??
          (params.failures && params.failures.length > 0 ? 'PARTIAL_FAILURE' : 'COMPLETED'),
        cleanedDecoys: params.cleanedDecoys,
        cleanedRoutes: params.cleanedRoutes,
        cleanedQuarantines: params.cleanedQuarantines,
        discoveredOrphans: params.discoveredOrphans,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        failures: params.failures ? (params.failures as any) : undefined,
        completedAt: new Date(),
      },
    });
  }

  async claimLeasesForCleanup(params: { sweepOwnerToken: string; asOf?: Date }) {
    const asOf = params.asOf ?? new Date();

    return this.leasePrisma.$transaction(async (tx) => {
      // Find expired active leases
      const [rawDecoys, rawRoutes, rawQuarantines] = await Promise.all([
        tx.decoyDeploymentLease.findMany({
          where: {
            leaseStatus: {
              in: ['ACTIVE', 'CLEANUP_PENDING', 'PENDING_CLEANUP', 'EMERGENCY_RELEASE_PENDING'],
            },
            expiresAt: { lte: asOf },
          },
        }),
        tx.falseRouteLease.findMany({
          where: {
            leaseStatus: {
              in: ['ACTIVE', 'CLEANUP_PENDING', 'EMERGENCY_RELEASE_PENDING', 'PENDING_RELEASE'],
            },
            expiresAt: { lte: asOf },
          },
        }),
        tx.quarantineLease.findMany({
          where: {
            leaseStatus: {
              in: ['ACTIVE', 'CLEANUP_PENDING', 'EMERGENCY_RELEASE_PENDING', 'PENDING_RELEASE'],
            },
            expiresAt: { lte: asOf },
          },
        }),
      ]);

      const claimedDecoys = await Promise.all(
        rawDecoys.map((d) =>
          tx.decoyDeploymentLease.update({
            where: { id: d.id, version: d.version },
            data: {
              ownerId: params.sweepOwnerToken,
              desiredState: 'DELETED',
              leaseStatus: 'CLEANUP_PENDING',
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      const claimedRoutes = await Promise.all(
        rawRoutes.map((r) =>
          tx.falseRouteLease.update({
            where: { id: r.id, version: r.version },
            data: {
              ownerId: params.sweepOwnerToken,
              desiredState: 'REVOKED',
              leaseStatus: 'CLEANUP_PENDING',
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      const claimedQuarantines = await Promise.all(
        rawQuarantines.map((q) =>
          tx.quarantineLease.update({
            where: { id: q.id, version: q.version },
            data: {
              ownerId: params.sweepOwnerToken,
              desiredState: 'RELEASED',
              leaseStatus: 'CLEANUP_PENDING',
              fencingToken: { increment: 1 },
              version: { increment: 1 },
            },
          }),
        ),
      );

      return {
        claimedDecoys,
        claimedRoutes,
        claimedQuarantines,
      };
    });
  }

  async findExpiredLeases(asOf = new Date()) {
    const [decoys, routes, quarantines] = await Promise.all([
      this.leasePrisma.decoyDeploymentLease.findMany({
        where: {
          leaseStatus: {
            in: ['ACTIVE', 'CLEANUP_PENDING', 'PENDING_CLEANUP', 'EMERGENCY_RELEASE_PENDING'],
          },
          expiresAt: { lte: asOf },
        },
      }),
      this.leasePrisma.falseRouteLease.findMany({
        where: {
          leaseStatus: {
            in: ['ACTIVE', 'CLEANUP_PENDING', 'EMERGENCY_RELEASE_PENDING', 'PENDING_RELEASE'],
          },
          expiresAt: { lte: asOf },
        },
      }),
      this.leasePrisma.quarantineLease.findMany({
        where: {
          leaseStatus: {
            in: ['ACTIVE', 'CLEANUP_PENDING', 'EMERGENCY_RELEASE_PENDING', 'PENDING_RELEASE'],
          },
          expiresAt: { lte: asOf },
        },
      }),
    ]);
    return { decoys, routes, quarantines };
  }

  /** Provider identifiers owned by any durable lease, including terminal cleanup failures. */
  async findLeaseOwnershipKeys(): Promise<{
    decoyOperationKeys: Set<string>;
    routeOperationKeys: Set<string>;
    quarantineOperationKeys: Set<string>;
  }> {
    const [decoys, routes, quarantines] = await Promise.all([
      this.leasePrisma.decoyDeploymentLease.findMany({
        select: { eventId: true },
      }),
      this.leasePrisma.falseRouteLease.findMany({
        select: { eventId: true },
      }),
      this.leasePrisma.quarantineLease.findMany({
        select: { eventId: true },
      }),
    ]);

    return {
      decoyOperationKeys: new Set(decoys.map((d) => `idem-request_decoy_deployment-${d.eventId}`)),
      routeOperationKeys: new Set(
        routes.map((r) => `idem-request_false_route_assignment-${r.eventId}`),
      ),
      quarantineOperationKeys: new Set(
        quarantines.map((q) => `idem-request_source_quarantine-${q.eventId}`),
      ),
    };
  }

  async findAllUnsettledLeases(): Promise<UnsettledLeasesResult> {
    const [decoys, routes, quarantines, intents] = await Promise.all([
      this.leasePrisma.decoyDeploymentLease.findMany(),
      this.leasePrisma.falseRouteLease.findMany(),
      this.leasePrisma.quarantineLease.findMany(),
      this.leasePrisma.providerIntentRecord.findMany({
        where: { status: { in: ['PENDING', 'CLAIMED'] } },
      }),
    ]);

    let activeDecoys = 0;
    let pendingDecoys = 0;
    let failedDecoys = 0;

    for (const d of decoys) {
      if (d.leaseStatus === 'ACTIVE') activeDecoys++;
      else if (d.leaseStatus === 'CLEANUP_PENDING' || d.leaseStatus === 'PENDING_CLEANUP')
        pendingDecoys++;
      else if (d.leaseStatus === 'TERMINAL_FAILURE' || d.observedState !== 'DELETED')
        failedDecoys++;
    }

    let activeRoutes = 0;
    let pendingRoutes = 0;
    let failedRoutes = 0;

    for (const r of routes) {
      if (r.leaseStatus === 'ACTIVE') activeRoutes++;
      else if (r.leaseStatus === 'CLEANUP_PENDING') pendingRoutes++;
      else if (r.leaseStatus === 'TERMINAL_FAILURE' || r.observedState !== 'REVOKED')
        failedRoutes++;
    }

    let activeQuarantines = 0;
    let pendingQuarantines = 0;
    let failedQuarantines = 0;

    for (const q of quarantines) {
      if (q.leaseStatus === 'ACTIVE') activeQuarantines++;
      else if (q.leaseStatus === 'CLEANUP_PENDING') pendingQuarantines++;
      else if (q.leaseStatus === 'TERMINAL_FAILURE' || q.observedState !== 'RELEASED')
        failedQuarantines++;
    }

    const ambiguousIntents = intents.length;
    const totalUnsettled =
      activeDecoys +
      pendingDecoys +
      failedDecoys +
      activeRoutes +
      pendingRoutes +
      failedRoutes +
      activeQuarantines +
      pendingQuarantines +
      failedQuarantines +
      ambiguousIntents;

    return {
      activeDecoys,
      pendingDecoys,
      failedDecoys,
      activeRoutes,
      pendingRoutes,
      failedRoutes,
      activeQuarantines,
      pendingQuarantines,
      failedQuarantines,
      ambiguousIntents,
      totalUnsettled,
    };
  }

  async markDecoyCleanedUp(params: { leaseId: string; ownerId: string; fencingToken: number }) {
    const result = await this.leasePrisma.decoyDeploymentLease.updateMany({
      where: {
        id: params.leaseId,
        ownerId: params.ownerId,
        fencingToken: params.fencingToken,
        leaseStatus: { in: ['ACTIVE', 'CLEANUP_PENDING', 'PENDING_CLEANUP'] },
      },
      data: {
        leaseStatus: 'CLEANED_UP',
        desiredState: 'DELETED',
        observedState: 'DELETED',
        cleanedUpAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new Error('Decoy lease cleanup fence was lost');
    return result;
  }

  async markRouteRevoked(params: { leaseId: string; ownerId: string; fencingToken: number }) {
    const result = await this.leasePrisma.falseRouteLease.updateMany({
      where: {
        id: params.leaseId,
        ownerId: params.ownerId,
        fencingToken: params.fencingToken,
        leaseStatus: { in: ['ACTIVE', 'CLEANUP_PENDING'] },
      },
      data: {
        leaseStatus: 'REVOKED',
        desiredState: 'REVOKED',
        observedState: 'REVOKED',
        revokedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new Error('False-route lease cleanup fence was lost');
    return result;
  }

  async markQuarantineReleased(params: { leaseId: string; ownerId: string; fencingToken: number }) {
    const result = await this.leasePrisma.quarantineLease.updateMany({
      where: {
        id: params.leaseId,
        ownerId: params.ownerId,
        fencingToken: params.fencingToken,
        leaseStatus: { in: ['ACTIVE', 'CLEANUP_PENDING'] },
      },
      data: {
        leaseStatus: 'CLEANED_UP',
        desiredState: 'RELEASED',
        observedState: 'RELEASED',
        releasedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new Error('Quarantine lease cleanup fence was lost');
    return result;
  }

  async recordLeaseCleanupFailure(params: {
    leaseId: string;
    kind: 'DECOY' | 'FALSE_ROUTE' | 'QUARANTINE';
    error: string;
    ownerId?: string | undefined;
    fencingToken?: number | undefined;
    maxAttempts?: number;
  }) {
    const maxAttempts = params.maxAttempts ?? 3;

    if (params.kind === 'DECOY') {
      const lease = await this.leasePrisma.decoyDeploymentLease.findUnique({
        where: { id: params.leaseId },
      });
      if (!lease) return;
      if (params.ownerId && lease.ownerId !== params.ownerId) {
        throw new Error(
          `Stale cleanup worker owner: expected ${params.ownerId} but found ${lease.ownerId}`,
        );
      }
      if (params.fencingToken !== undefined && lease.fencingToken !== params.fencingToken) {
        throw new Error(
          `Stale cleanup fencing token: expected ${params.fencingToken} but found ${lease.fencingToken}`,
        );
      }
      const nextAttempts = lease.cleanupAttempts + 1;
      const result = await this.leasePrisma.decoyDeploymentLease.updateMany({
        where: {
          id: params.leaseId,
          ...(params.ownerId ? { ownerId: params.ownerId } : {}),
          ...(params.fencingToken !== undefined ? { fencingToken: params.fencingToken } : {}),
          version: lease.version,
        },
        data: {
          cleanupAttempts: nextAttempts,
          lastFailureReason: params.error.slice(0, 512),
          leaseStatus: nextAttempts >= maxAttempts ? 'TERMINAL_FAILURE' : lease.leaseStatus,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        throw new Error(
          `Failed to record cleanup failure for decoy lease ${params.leaseId}: fence lost`,
        );
      }
    } else if (params.kind === 'FALSE_ROUTE') {
      const lease = await this.leasePrisma.falseRouteLease.findUnique({
        where: { id: params.leaseId },
      });
      if (!lease) return;
      if (params.ownerId && lease.ownerId !== params.ownerId) {
        throw new Error(
          `Stale cleanup worker owner: expected ${params.ownerId} but found ${lease.ownerId}`,
        );
      }
      if (params.fencingToken !== undefined && lease.fencingToken !== params.fencingToken) {
        throw new Error(
          `Stale cleanup fencing token: expected ${params.fencingToken} but found ${lease.fencingToken}`,
        );
      }
      const nextAttempts = lease.cleanupAttempts + 1;
      const result = await this.leasePrisma.falseRouteLease.updateMany({
        where: {
          id: params.leaseId,
          ...(params.ownerId ? { ownerId: params.ownerId } : {}),
          ...(params.fencingToken !== undefined ? { fencingToken: params.fencingToken } : {}),
          version: lease.version,
        },
        data: {
          cleanupAttempts: nextAttempts,
          lastFailureReason: params.error.slice(0, 512),
          leaseStatus: nextAttempts >= maxAttempts ? 'TERMINAL_FAILURE' : lease.leaseStatus,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        throw new Error(
          `Failed to record cleanup failure for false route lease ${params.leaseId}: fence lost`,
        );
      }
    } else if (params.kind === 'QUARANTINE') {
      const lease = await this.leasePrisma.quarantineLease.findUnique({
        where: { id: params.leaseId },
      });
      if (!lease) return;
      if (params.ownerId && lease.ownerId !== params.ownerId) {
        throw new Error(
          `Stale cleanup worker owner: expected ${params.ownerId} but found ${lease.ownerId}`,
        );
      }
      if (params.fencingToken !== undefined && lease.fencingToken !== params.fencingToken) {
        throw new Error(
          `Stale cleanup fencing token: expected ${params.fencingToken} but found ${lease.fencingToken}`,
        );
      }
      const nextAttempts = lease.cleanupAttempts + 1;
      const result = await this.leasePrisma.quarantineLease.updateMany({
        where: {
          id: params.leaseId,
          ...(params.ownerId ? { ownerId: params.ownerId } : {}),
          ...(params.fencingToken !== undefined ? { fencingToken: params.fencingToken } : {}),
          version: lease.version,
        },
        data: {
          cleanupAttempts: nextAttempts,
          lastFailureReason: params.error.slice(0, 512),
          leaseStatus: nextAttempts >= maxAttempts ? 'TERMINAL_FAILURE' : lease.leaseStatus,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        throw new Error(
          `Failed to record cleanup failure for quarantine lease ${params.leaseId}: fence lost`,
        );
      }
    }
  }
}
