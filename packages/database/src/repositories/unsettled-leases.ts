export interface UnsettledLeasesResult {
  readonly activeDecoys: number;
  readonly pendingDecoys: number;
  readonly failedDecoys: number;
  readonly activeRoutes: number;
  readonly pendingRoutes: number;
  readonly failedRoutes: number;
  readonly activeQuarantines: number;
  readonly pendingQuarantines: number;
  readonly failedQuarantines: number;
  readonly ambiguousIntents: number;
  readonly totalUnsettled: number;
}

export type EmergencyLeaseKind = 'ROUTE' | 'QUARANTINE' | 'DECOY';

export interface EmergencyLeaseState {
  readonly kind: EmergencyLeaseKind;
  readonly leaseStatus: string;
  readonly lastFailureReason: string | null;
}

export type EmergencyLeaseOutcome = 'VERIFIED' | 'FAILED' | 'PENDING';

export interface EmergencyReleaseCounts {
  readonly requestedCount: number;
  readonly verifiedCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  /** Routes and quarantines still awaiting settlement; decoys are excluded because they are always deferred to cleanup. */
  readonly pendingSettlementCount: number;
}

/**
 * Durable marker written into `lastFailureReason` when an emergency settlement attempt fails.
 * Classification depends on this prefix so an unrelated cleanup failure is not counted as an
 * emergency failure.
 */
export const EMERGENCY_FAILURE_REASON_PREFIX = 'Emergency ';

const TERMINAL_SUCCESS_STATUSES: Record<EmergencyLeaseKind, readonly string[]> = {
  ROUTE: ['REVOKED', 'CLEANED_UP'],
  QUARANTINE: ['CLEANED_UP', 'RELEASED'],
  DECOY: ['CLEANED_UP'],
};

export function classifyEmergencyLease(lease: EmergencyLeaseState): EmergencyLeaseOutcome {
  if (TERMINAL_SUCCESS_STATUSES[lease.kind].includes(lease.leaseStatus)) {
    return 'VERIFIED';
  }
  if (
    lease.leaseStatus === 'TERMINAL_FAILURE' ||
    (lease.lastFailureReason?.startsWith(EMERGENCY_FAILURE_REASON_PREFIX) ?? false)
  ) {
    return 'FAILED';
  }
  return 'PENDING';
}

/**
 * Derives emergency-release counters from durable lease state so that
 * `requestedCount === verifiedCount + pendingCount + failedCount` holds by construction and
 * cannot drift across retries.
 *
 * `missingLeaseCount` covers leases claimed by the operation whose rows no longer exist. An
 * absent row cannot hold a simulated resource, so it is reconciled as verified rather than
 * silently dropped from the total.
 */
export function summarizeEmergencyLeases(
  leases: readonly EmergencyLeaseState[],
  missingLeaseCount = 0,
): EmergencyReleaseCounts {
  let verifiedCount = missingLeaseCount;
  let pendingCount = 0;
  let failedCount = 0;
  let pendingSettlementCount = 0;

  for (const lease of leases) {
    const outcome = classifyEmergencyLease(lease);
    if (outcome === 'VERIFIED') {
      verifiedCount++;
    } else if (outcome === 'FAILED') {
      failedCount++;
    } else {
      pendingCount++;
      if (lease.kind !== 'DECOY') pendingSettlementCount++;
    }
  }

  return {
    requestedCount: verifiedCount + pendingCount + failedCount,
    verifiedCount,
    pendingCount,
    failedCount,
    pendingSettlementCount,
  };
}

/**
 * An emergency release is only COMPLETED when every route and quarantine reached a terminal
 * successful state. Decoys remain pending for the worker cleanup sweep by design.
 */
export function deriveEmergencyReleaseStatus(
  counts: EmergencyReleaseCounts,
): 'COMPLETED' | 'PARTIAL_FAILURE' | 'PENDING' {
  if (counts.failedCount > 0) return 'PARTIAL_FAILURE';
  if (counts.pendingSettlementCount > 0) return 'PENDING';
  return 'COMPLETED';
}
