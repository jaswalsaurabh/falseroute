import { randomUUID } from 'node:crypto';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  FakeCloudRunAdapter,
  FakeFalseRouteAdapter,
  FakeCloudArmorAdapter,
} from '../tools/fake-cloud-adapters.js';

export interface LeaseCleanupOptions {
  readonly cloudRunAdapter?: FakeCloudRunAdapter;
  readonly falseRouteAdapter?: FakeFalseRouteAdapter;
  readonly cloudArmorAdapter?: FakeCloudArmorAdapter;
  readonly maxAttempts?: number;
}

export interface CleanupSweepResult {
  readonly sweepOwnerToken: string;
  readonly status: 'COMPLETED' | 'PARTIAL_FAILURE' | 'SKIPPED';
  readonly cleanedDecoys: number;
  readonly cleanedRoutes: number;
  readonly cleanedQuarantines: number;
  readonly discoveredOrphans: number;
  readonly totalCleaned: number;
  readonly failures: readonly {
    readonly leaseId: string;
    readonly kind: string;
    readonly error: string;
  }[];
}

export interface RollbackVerificationResult {
  readonly rollbackComplete: boolean;
  readonly activeDecoyCount: number;
  readonly pendingDecoyCount: number;
  readonly failedDecoyCount: number;
  readonly activeRouteCount: number;
  readonly pendingRouteCount: number;
  readonly failedRouteCount: number;
  readonly activeQuarantineCount: number;
  readonly pendingQuarantineCount: number;
  readonly failedQuarantineCount: number;
  readonly ambiguousIntentCount: number;
  readonly discoveredOrphanCount: number;
  readonly details: string;
}

export class LeaseCleanupService {
  private readonly cloudRun: FakeCloudRunAdapter;
  private readonly falseRoute: FakeFalseRouteAdapter;
  private readonly cloudArmor: FakeCloudArmorAdapter;
  private readonly maxAttempts: number;

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    options: LeaseCleanupOptions = {},
  ) {
    this.cloudRun = options.cloudRunAdapter ?? new FakeCloudRunAdapter();
    this.falseRoute = options.falseRouteAdapter ?? new FakeFalseRouteAdapter();
    this.cloudArmor = options.cloudArmorAdapter ?? new FakeCloudArmorAdapter();
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async sweepExpiredLeases(params?: {
    sweepOwnerId?: string;
    asOf?: Date;
  }): Promise<CleanupSweepResult> {
    const sweepOwnerToken = params?.sweepOwnerId ?? `sweep-${randomUUID()}`;
    const asOf = params?.asOf ?? new Date();

    // 1. Acquire durable sweep lock
    const lockOutcome = await this.workflowRepo
      .acquireCleanupSweepLock({ sweepOwnerToken, ttlMs: 60_000 })
      .catch(() => ({ acquired: false, reason: 'Failed to acquire sweep lock' }));

    if (!lockOutcome.acquired) {
      return {
        sweepOwnerToken,
        status: 'SKIPPED',
        cleanedDecoys: 0,
        cleanedRoutes: 0,
        cleanedQuarantines: 0,
        discoveredOrphans: 0,
        totalCleaned: 0,
        failures: [
          {
            leaseId: 'sweep-lock',
            kind: 'SWEEP_LOCK',
            error: lockOutcome.reason ?? 'Lock not acquired',
          },
        ],
      };
    }

    // 2. Atomically claim eligible expired leases
    const { claimedDecoys, claimedRoutes, claimedQuarantines } =
      await this.workflowRepo.claimLeasesForCleanup({ sweepOwnerToken, asOf });

    let cleanedDecoys = 0;
    let cleanedRoutes = 0;
    let cleanedQuarantines = 0;
    const failures: { leaseId: string; kind: string; error: string }[] = [];

    // 3. Settle expired decoys in parallel
    const decoyResults = await Promise.all(
      claimedDecoys.map(async (decoy) => {
        try {
          const operationKey = `idem-request_decoy_deployment-${decoy.eventId}`;
          const deleteResult = await this.cloudRun.deleteDecoyByOperation(operationKey);
          const isAbsent = !this.cloudRun.getDecoyByOperation(operationKey);
          if (!deleteResult.deleted && !isAbsent) {
            throw new Error(`FakeCloudRunAdapter deleteDecoy failed for operation ${operationKey}`);
          }

          await this.workflowRepo.markDecoyCleanedUp({
            leaseId: decoy.id,
            ownerId: sweepOwnerToken,
            fencingToken: decoy.fencingToken,
          });

          await this.activityRepo
            .recordActivityEvent({
              eventId: decoy.eventId,
              correlationId: `corr-cleanup-${decoy.id}`,
              stage: 'COMPLETED',
              eventType: 'LEASE_EXPIRED_CLEANED_UP',
              summary: `Cleaned up expired decoy deployment lease for ${decoy.templateName}`,
              provenance: 'DERIVED',
              payload: { leaseId: decoy.id, templateName: decoy.templateName, kind: 'DECOY' },
            })
            .catch(() => {});

          return { success: true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await this.workflowRepo
            .recordLeaseCleanupFailure({
              leaseId: decoy.id,
              kind: 'DECOY',
              error: errorMsg,
              ownerId: sweepOwnerToken,
              fencingToken: decoy.fencingToken,
              maxAttempts: this.maxAttempts,
            })
            .catch(() => {});

          return {
            success: false,
            failure: { leaseId: decoy.id, kind: 'DECOY', error: errorMsg },
          };
        }
      }),
    );

    for (const r of decoyResults) {
      if (r.success) cleanedDecoys++;
      else if (r.failure) failures.push(r.failure);
    }

    // 4. Settle expired false routes in parallel
    const routeResults = await Promise.all(
      claimedRoutes.map(async (route) => {
        try {
          const operationKey = `idem-request_false_route_assignment-${route.eventId}`;
          const revokeResult = await this.falseRoute.revokeRouteByOperation(operationKey);
          const isAbsent = !this.falseRoute.getRouteByOperation(operationKey);
          if (!revokeResult.revoked && !isAbsent) {
            throw new Error(
              `FakeFalseRouteAdapter revokeRoute failed for operation ${operationKey}`,
            );
          }

          await this.workflowRepo.markRouteRevoked({
            leaseId: route.id,
            ownerId: sweepOwnerToken,
            fencingToken: route.fencingToken,
          });

          await this.activityRepo
            .recordActivityEvent({
              eventId: route.eventId,
              correlationId: `corr-cleanup-${route.id}`,
              stage: 'COMPLETED',
              eventType: 'LEASE_EXPIRED_CLEANED_UP',
              summary: `Revoked expired false-route lease for source ${route.sourceIp}`,
              provenance: 'DERIVED',
              payload: { leaseId: route.id, sourceIp: route.sourceIp, kind: 'FALSE_ROUTE' },
            })
            .catch(() => {});

          return { success: true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await this.workflowRepo
            .recordLeaseCleanupFailure({
              leaseId: route.id,
              kind: 'FALSE_ROUTE',
              error: errorMsg,
              ownerId: sweepOwnerToken,
              fencingToken: route.fencingToken,
              maxAttempts: this.maxAttempts,
            })
            .catch(() => {});

          return {
            success: false,
            failure: { leaseId: route.id, kind: 'FALSE_ROUTE', error: errorMsg },
          };
        }
      }),
    );

    for (const r of routeResults) {
      if (r.success) cleanedRoutes++;
      else if (r.failure) failures.push(r.failure);
    }

    // 5. Settle expired quarantine rules in parallel
    const quarantineResults = await Promise.all(
      claimedQuarantines.map(async (q) => {
        try {
          const operationKey = `idem-request_source_quarantine-${q.eventId}`;
          const releaseResult = await this.cloudArmor.releaseQuarantineByOperation(operationKey);
          const isAbsent = !this.cloudArmor.getQuarantineByOperation(operationKey);
          if (!releaseResult.released && !isAbsent) {
            throw new Error(
              `FakeCloudArmorAdapter releaseQuarantine failed for operation ${operationKey}`,
            );
          }

          await this.workflowRepo.markQuarantineReleased({
            leaseId: q.id,
            ownerId: sweepOwnerToken,
            fencingToken: q.fencingToken,
          });

          await this.activityRepo
            .recordActivityEvent({
              eventId: q.eventId,
              correlationId: `corr-cleanup-${q.id}`,
              stage: 'COMPLETED',
              eventType: 'LEASE_EXPIRED_CLEANED_UP',
              summary: `Released expired quarantine lease for ${q.sourceCidr}`,
              provenance: 'DERIVED',
              payload: { leaseId: q.id, sourceCidr: q.sourceCidr, kind: 'QUARANTINE' },
            })
            .catch(() => {});

          return { success: true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await this.workflowRepo
            .recordLeaseCleanupFailure({
              leaseId: q.id,
              kind: 'QUARANTINE',
              error: errorMsg,
              ownerId: sweepOwnerToken,
              fencingToken: q.fencingToken,
              maxAttempts: this.maxAttempts,
            })
            .catch(() => {});

          return {
            success: false,
            failure: { leaseId: q.id, kind: 'QUARANTINE', error: errorMsg },
          };
        }
      }),
    );

    for (const r of quarantineResults) {
      if (r.success) cleanedQuarantines++;
      else if (r.failure) failures.push(r.failure);
    }

    // 6. Deterministic orphan reconciliation against fake providers
    let discoveredOrphans = 0;
    try {
      discoveredOrphans = await this.cleanupOrphanedResources();
    } catch (err) {
      failures.push({
        leaseId: 'orphan-discovery',
        kind: 'INVENTORY_OBSERVATION',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 7. Reconcile expired budget reservations
    try {
      await this.workflowRepo.reconcileExpiredReservations(asOf);
    } catch (err) {
      failures.push({
        leaseId: 'budget-reconciliation',
        kind: 'BUDGET',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 8. Complete sweep record
    let status = failures.length > 0 ? ('PARTIAL_FAILURE' as const) : ('COMPLETED' as const);
    try {
      await this.workflowRepo.completeCleanupSweepRecord({
        sweepOwnerToken,
        cleanedDecoys,
        cleanedRoutes,
        cleanedQuarantines,
        discoveredOrphans,
        failures,
        status,
      });
    } catch (err) {
      failures.push({
        leaseId: 'sweep-completion',
        kind: 'SWEEP_PERSISTENCE',
        error: err instanceof Error ? err.message : String(err),
      });
      status = 'PARTIAL_FAILURE';
    }

    return {
      sweepOwnerToken,
      status,
      cleanedDecoys,
      cleanedRoutes,
      cleanedQuarantines,
      discoveredOrphans,
      totalCleaned: cleanedDecoys + cleanedRoutes + cleanedQuarantines,
      failures,
    };
  }

  async discoverOrphanedResources(): Promise<number> {
    const { decoyOperationKeys, routeOperationKeys, quarantineOperationKeys } =
      await this.workflowRepo.findLeaseOwnershipKeys();

    const providerDecoys = this.cloudRun.listDecoys();
    const providerRoutes = this.falseRoute.listRoutes();
    const providerQuarantines = this.cloudArmor.listQuarantines();

    let orphanCount = 0;
    for (const d of providerDecoys) {
      if (!d.operationKey || !decoyOperationKeys.has(d.operationKey)) {
        orphanCount++;
      }
    }
    for (const r of providerRoutes) {
      if (!r.operationKey || !routeOperationKeys.has(r.operationKey)) {
        orphanCount++;
      }
    }
    for (const q of providerQuarantines) {
      if (!q.operationKey || !quarantineOperationKeys.has(q.operationKey)) {
        orphanCount++;
      }
    }

    return orphanCount;
  }

  private async cleanupOrphanedResources(): Promise<number> {
    const { decoyOperationKeys, routeOperationKeys, quarantineOperationKeys } =
      await this.workflowRepo.findLeaseOwnershipKeys();

    const orphanedDecoys = this.cloudRun
      .listDecoys()
      .filter((decoy) => !decoy.operationKey || !decoyOperationKeys.has(decoy.operationKey));
    const orphanedRoutes = this.falseRoute
      .listRoutes()
      .filter((route) => !route.operationKey || !routeOperationKeys.has(route.operationKey));
    const orphanedQuarantines = this.cloudArmor
      .listQuarantines()
      .filter(
        (quarantine) =>
          !quarantine.operationKey || !quarantineOperationKeys.has(quarantine.operationKey),
      );

    await Promise.all([
      ...orphanedDecoys.map(async (decoy) => {
        const result = await this.cloudRun.deleteDecoy(decoy.serviceId);
        if (!result.deleted && this.cloudRun.getDecoy(decoy.serviceId)) {
          throw new Error(`Failed to clean up orphaned decoy ${decoy.serviceId}`);
        }
      }),
      ...orphanedRoutes.map(async (route) => {
        const result = await this.falseRoute.revokeRoute(route.sourceIp);
        if (!result.revoked && this.falseRoute.getRoute(route.sourceIp)) {
          throw new Error(`Failed to clean up orphaned route ${route.sourceIp}`);
        }
      }),
      ...orphanedQuarantines.map(async (quarantine) => {
        const result = await this.cloudArmor.releaseQuarantine(quarantine.sourceCidr);
        if (!result.released && this.cloudArmor.getQuarantine(quarantine.sourceCidr)) {
          throw new Error(`Failed to clean up orphaned quarantine ${quarantine.sourceCidr}`);
        }
      }),
    ]);

    return orphanedDecoys.length + orphanedRoutes.length + orphanedQuarantines.length;
  }

  async verifyRollbackState(): Promise<RollbackVerificationResult> {
    try {
      const unsettled = await this.workflowRepo.findAllUnsettledLeases();

      const providerDecoys = this.cloudRun.listDecoys();
      const providerRoutes = this.falseRoute.listRoutes();
      const providerQuarantines = this.cloudArmor.listQuarantines();
      const providerActiveTotal =
        providerDecoys.length + providerRoutes.length + providerQuarantines.length;

      const discoveredOrphans = await this.discoverOrphanedResources();

      const rollbackComplete =
        unsettled.totalUnsettled === 0 && providerActiveTotal === 0 && discoveredOrphans === 0;

      const details = rollbackComplete
        ? 'Rollback verified: zero active, pending, failed, or orphaned resources across DB and provider inventories'
        : `Rollback incomplete: ${unsettled.totalUnsettled} unsettled leases in DB, ${providerActiveTotal} provider resources active, ${discoveredOrphans} orphans discovered`;

      return {
        rollbackComplete,
        activeDecoyCount: unsettled.activeDecoys,
        pendingDecoyCount: unsettled.pendingDecoys,
        failedDecoyCount: unsettled.failedDecoys,
        activeRouteCount: unsettled.activeRoutes,
        pendingRouteCount: unsettled.pendingRoutes,
        failedRouteCount: unsettled.failedRoutes,
        activeQuarantineCount: unsettled.activeQuarantines,
        pendingQuarantineCount: unsettled.pendingQuarantines,
        failedQuarantineCount: unsettled.failedQuarantines,
        ambiguousIntentCount: unsettled.ambiguousIntents,
        discoveredOrphanCount: discoveredOrphans,
        details,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        rollbackComplete: false,
        activeDecoyCount: 0,
        pendingDecoyCount: 0,
        failedDecoyCount: 0,
        activeRouteCount: 0,
        pendingRouteCount: 0,
        failedRouteCount: 0,
        activeQuarantineCount: 0,
        pendingQuarantineCount: 0,
        failedQuarantineCount: 0,
        ambiguousIntentCount: 0,
        discoveredOrphanCount: 0,
        details: `Rollback verification failed closed due to observation error: ${errorMsg}`,
      };
    }
  }
}
