import {
  type EmergencyReleaseRequest,
  type EmergencyReleaseResponse,
  EmergencyReleaseRequestSchema,
  EmergencyReleaseResponseSchema,
} from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';

/**
 * Simulated false-route provider. `hasActiveRoute` is the observation boundary: the service may
 * never claim a route was released without observing the simulated inventory.
 */
export interface FakeRouteRevoker {
  revokeRoute(sourceIp: string): Promise<{ revoked: boolean; status: 'SIMULATED' }>;
  hasActiveRoute(sourceIp: string): Promise<boolean>;
}

export interface FakeQuarantineReleaser {
  releaseQuarantine(sourceCidr: string): Promise<{ released: boolean; status: 'SIMULATED' }>;
  hasActiveQuarantine(sourceCidr: string): Promise<boolean>;
}

export interface EmergencyReleaseServiceOptions {
  readonly falseRouteAdapter?: FakeRouteRevoker | undefined;
  readonly cloudArmorAdapter?: FakeQuarantineReleaser | undefined;
}

/**
 * RELEASED  - the simulated resource is observed absent and the durable CAS succeeded.
 * FAILED    - the resource is observed still present, or the durable CAS was lost.
 * DEFERRED  - provider state is unknown, or no observable adapter is wired; the lease stays
 *             pending and immediately eligible for the worker cleanup sweep.
 */
type SettlementOutcome = 'RELEASED' | 'FAILED' | 'DEFERRED';

export class EmergencyReleaseService {
  private readonly falseRoute: FakeRouteRevoker | undefined;
  private readonly cloudArmor: FakeQuarantineReleaser | undefined;

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    options: EmergencyReleaseServiceOptions = {},
  ) {
    this.falseRoute = options.falseRouteAdapter;
    this.cloudArmor = options.cloudArmorAdapter;
  }

  async executeEmergencyRelease(
    input: EmergencyReleaseRequest,
    correlationId: string,
    principalId = 'operator-principal',
  ): Promise<EmergencyReleaseResponse> {
    const validated = EmergencyReleaseRequestSchema.parse(input);

    // 1. Transactional phase: claim the operation and its unsettled leases with idempotency
    const claim = await this.workflowRepo.claimEmergencyRelease({
      idempotencyKey: validated.idempotencyKey,
      principalId,
      reason: validated.reason,
      correlationId,
    });

    if (claim.isDuplicate) {
      const existing = claim.record;
      const isCompleted = existing.status === 'COMPLETED';
      return EmergencyReleaseResponseSchema.parse({
        id: existing.id,
        idempotencyKey: existing.idempotencyKey,
        status: 'RECORDED',
        containmentMode: 'SIMULATED',
        releasedCount: { falseRoutes: 0, quarantines: 0, decoys: 0 },
        requestedCount: existing.requestedCount,
        verifiedCount: existing.verifiedCount,
        pendingCount: existing.pendingCount,
        failedCount: existing.failedCount,
        timestamp: existing.createdAt.toISOString(),
        message: isCompleted
          ? `Idempotent replay: emergency release already completed for key ${validated.idempotencyKey}`
          : `Idempotent replay: emergency release is already in progress for key ${validated.idempotencyKey}`,
      });
    }

    const { record, claimedRoutes, claimedQuarantines, claimedDecoys, emergencyOwnerToken } = claim;

    // 2. Settlement phase: observe the simulated inventory, then fence the durable transition
    const settledRoutes = await Promise.all(
      claimedRoutes.map((route) =>
        this.settleRoute(route.id, route.sourceIp, route.fencingToken, emergencyOwnerToken),
      ),
    );
    const settledQuarantines = await Promise.all(
      claimedQuarantines.map((quarantine) =>
        this.settleQuarantine(
          quarantine.id,
          quarantine.sourceCidr,
          quarantine.fencingToken,
          emergencyOwnerToken,
        ),
      ),
    );

    const releasedRoutes = settledRoutes.filter((outcome) => outcome === 'RELEASED').length;
    const releasedQuarantines = settledQuarantines.filter(
      (outcome) => outcome === 'RELEASED',
    ).length;

    // 3. Derive durable counters (fails closed: a persistence failure keeps the record retryable)
    const settledRecord = await this.workflowRepo.settleEmergencyReleaseRecord({
      recordId: record.id,
      emergencyOwnerToken,
    });

    await this.recordActivity({
      claim,
      correlationId,
      principalId,
      reason: validated.reason,
      idempotencyKey: validated.idempotencyKey,
      releasedRoutes,
      releasedQuarantines,
    });

    const pendingSettlement = settledRecord.derivedCounts.pendingSettlementCount;
    const message =
      `Emergency release recorded (SIMULATED mode); ${settledRecord.verifiedCount} leases verified released, ` +
      `${claimedDecoys.length} decoys pending cleanup` +
      (pendingSettlement > 0
        ? `, ${pendingSettlement} route/quarantine leases pending worker cleanup`
        : '') +
      (settledRecord.failedCount > 0 ? `, ${settledRecord.failedCount} failed` : '');

    return EmergencyReleaseResponseSchema.parse({
      id: record.id,
      idempotencyKey: validated.idempotencyKey,
      status: 'RECORDED',
      containmentMode: 'SIMULATED',
      releasedCount: {
        falseRoutes: releasedRoutes,
        quarantines: releasedQuarantines,
        decoys: 0,
      },
      requestedCount: settledRecord.requestedCount,
      verifiedCount: settledRecord.verifiedCount,
      pendingCount: settledRecord.pendingCount,
      failedCount: settledRecord.failedCount,
      timestamp: new Date().toISOString(),
      message: message.slice(0, 500),
    });
  }

  private async settleRoute(
    leaseId: string,
    sourceIp: string,
    fencingToken: number,
    emergencyOwnerToken: string,
  ): Promise<SettlementOutcome> {
    const adapter = this.falseRoute;

    if (!adapter) {
      return this.deferRoute(leaseId, fencingToken, emergencyOwnerToken);
    }

    let observedAbsent: boolean;
    try {
      // An already-absent route is a reconciled success; do not repeat the provider mutation.
      if (await adapter.hasActiveRoute(sourceIp)) {
        await adapter.revokeRoute(sourceIp);
      }
      observedAbsent = !(await adapter.hasActiveRoute(sourceIp));
    } catch {
      return this.deferRoute(leaseId, fencingToken, emergencyOwnerToken);
    }

    if (!observedAbsent) {
      await this.workflowRepo
        .markEmergencyRouteReleased({
          leaseId,
          emergencyOwnerToken,
          fencingToken,
          success: false,
        })
        .catch(() => {});
      return 'FAILED';
    }

    const updateResult = await this.workflowRepo
      .markEmergencyRouteReleased({
        leaseId,
        emergencyOwnerToken,
        fencingToken,
        success: true,
      })
      .catch(() => ({ count: 0 }));

    if (updateResult.count !== 1) {
      // Durable ownership was lost or the write failed: never report a released route.
      await this.workflowRepo
        .markEmergencyRouteReleased({
          leaseId,
          emergencyOwnerToken,
          fencingToken,
          success: false,
        })
        .catch(() => {});
      return 'FAILED';
    }

    return 'RELEASED';
  }

  private async deferRoute(
    leaseId: string,
    fencingToken: number,
    emergencyOwnerToken: string,
  ): Promise<SettlementOutcome> {
    const updateResult = await this.workflowRepo
      .markEmergencyRouteReleased({
        leaseId,
        emergencyOwnerToken,
        fencingToken,
        success: false,
        deferToCleanup: true,
      })
      .catch(() => ({ count: 0 }));
    if (updateResult.count !== 1) {
      throw new Error('Emergency route cleanup deferral fence was lost');
    }
    return 'DEFERRED';
  }

  private async settleQuarantine(
    leaseId: string,
    sourceCidr: string,
    fencingToken: number,
    emergencyOwnerToken: string,
  ): Promise<SettlementOutcome> {
    const adapter = this.cloudArmor;

    if (!adapter) {
      return this.deferQuarantine(leaseId, fencingToken, emergencyOwnerToken);
    }

    let observedAbsent: boolean;
    try {
      if (await adapter.hasActiveQuarantine(sourceCidr)) {
        await adapter.releaseQuarantine(sourceCidr);
      }
      observedAbsent = !(await adapter.hasActiveQuarantine(sourceCidr));
    } catch {
      return this.deferQuarantine(leaseId, fencingToken, emergencyOwnerToken);
    }

    if (!observedAbsent) {
      await this.workflowRepo
        .markEmergencyQuarantineReleased({
          leaseId,
          emergencyOwnerToken,
          fencingToken,
          success: false,
        })
        .catch(() => {});
      return 'FAILED';
    }

    const updateResult = await this.workflowRepo
      .markEmergencyQuarantineReleased({
        leaseId,
        emergencyOwnerToken,
        fencingToken,
        success: true,
      })
      .catch(() => ({ count: 0 }));

    if (updateResult.count !== 1) {
      await this.workflowRepo
        .markEmergencyQuarantineReleased({
          leaseId,
          emergencyOwnerToken,
          fencingToken,
          success: false,
        })
        .catch(() => {});
      return 'FAILED';
    }

    return 'RELEASED';
  }

  private async deferQuarantine(
    leaseId: string,
    fencingToken: number,
    emergencyOwnerToken: string,
  ): Promise<SettlementOutcome> {
    const updateResult = await this.workflowRepo
      .markEmergencyQuarantineReleased({
        leaseId,
        emergencyOwnerToken,
        fencingToken,
        success: false,
        deferToCleanup: true,
      })
      .catch(() => ({ count: 0 }));
    if (updateResult.count !== 1) {
      throw new Error('Emergency quarantine cleanup deferral fence was lost');
    }
    return 'DEFERRED';
  }

  private async recordActivity(params: {
    claim: Extract<
      Awaited<ReturnType<AutonomousWorkflowRepository['claimEmergencyRelease']>>,
      { isDuplicate: false }
    >;
    correlationId: string;
    principalId: string;
    reason: string;
    idempotencyKey: string;
    releasedRoutes: number;
    releasedQuarantines: number;
  }): Promise<void> {
    const eventIds = new Set<string>();
    for (const r of params.claim.claimedRoutes) eventIds.add(r.eventId);
    for (const q of params.claim.claimedQuarantines) eventIds.add(q.eventId);
    for (const d of params.claim.claimedDecoys) eventIds.add(d.eventId);

    await Promise.all(
      Array.from(eventIds).map((eventId) =>
        this.activityRepo
          .recordActivityEvent({
            eventId,
            correlationId: params.correlationId,
            stage: 'COMPLETED',
            eventType: 'EMERGENCY_RELEASE_TRIGGERED',
            summary: `Emergency release executed by ${params.principalId}: ${params.reason}`,
            provenance: 'OPERATOR',
            payload: {
              reason: params.reason,
              principalId: params.principalId,
              idempotencyKey: params.idempotencyKey,
              releasedCount: {
                falseRoutes: params.releasedRoutes,
                quarantines: params.releasedQuarantines,
                decoys: 0,
              },
            },
          })
          .catch(() => {}),
      ),
    );
  }
}
