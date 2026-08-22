import type { PrismaClient } from '../generated/client/client.js';

export class LeaseRepository {
  constructor(protected readonly leasePrisma: PrismaClient) {}

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

  async findExpiredLeases(asOf = new Date()) {
    const [decoys, routes, quarantines] = await Promise.all([
      this.leasePrisma.decoyDeploymentLease.findMany({
        where: { leaseStatus: 'ACTIVE', expiresAt: { lte: asOf } },
      }),
      this.leasePrisma.falseRouteLease.findMany({
        where: { leaseStatus: 'ACTIVE', expiresAt: { lte: asOf } },
      }),
      this.leasePrisma.quarantineLease.findMany({
        where: { leaseStatus: 'ACTIVE', expiresAt: { lte: asOf } },
      }),
    ]);
    return { decoys, routes, quarantines };
  }

  async markDecoyCleanedUp(params: { leaseId: string; ownerId: string; fencingToken: number }) {
    const result = await this.leasePrisma.decoyDeploymentLease.updateMany({
      where: {
        id: params.leaseId,
        ownerId: params.ownerId,
        fencingToken: params.fencingToken,
        leaseStatus: 'ACTIVE',
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
        leaseStatus: 'ACTIVE',
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
        leaseStatus: 'ACTIVE',
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
}
