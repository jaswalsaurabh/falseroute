import { randomUUID } from 'node:crypto';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
  IntrusionEventSchema,
} from '@false-route/contracts';
import {
  type DatabaseClient,
  type DeceptionAction,
  type ContainmentMode,
  type ProvenanceClassification,
} from '@false-route/database';

interface RawIntrusionEventRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly received_at: Date;
  readonly correlation_id: string;
  readonly source_ip: string;
  readonly target_asset: string;
  readonly event_type: string;
  readonly failed_login_count: number;
  readonly risk_indicators: string[];
  readonly containment_mode: string;
  readonly used_decoy_credential: boolean;
  readonly decoy_identifier: string | null;
  readonly status: string;
  readonly provenance: string;
  readonly processing_claim_token: string | null;
  readonly processing_lease_expires_at: Date | null;
  readonly processing_attempt_count: number;
}

export interface ClaimedEvent {
  readonly event: IntrusionEvent;
  readonly claimToken: string;
}

export type ClaimReleaseOutcome = 'REQUEUED' | 'FAILED' | 'STALE_CLAIM' | 'ALREADY_DECIDED';

export interface WorkerRepositoryOptions {
  readonly claimLeaseDurationMs?: number | undefined;
  readonly maxProcessingAttempts?: number | undefined;
}

export interface WorkerRepository {
  claimNextPendingEvent(options?: {
    leaseDurationMs?: number | undefined;
    maxAttempts?: number | undefined;
  }): Promise<ClaimedEvent | null>;
  persistDecision(
    decision: DeceptionDecision,
    claimToken: string,
    simulatedEffect?: SimulatedDeceptionEffect | undefined,
  ): Promise<void>;
  releaseOrFailClaim(
    eventId: string,
    claimToken: string,
    options?: { maxAttempts?: number | undefined },
  ): Promise<ClaimReleaseOutcome>;
  checkHealth(): Promise<boolean>;
}

export class PrismaWorkerRepository implements WorkerRepository {
  private readonly claimLeaseDurationMs: number;
  private readonly maxProcessingAttempts: number;

  constructor(
    private readonly db: DatabaseClient,
    options?: WorkerRepositoryOptions,
  ) {
    this.claimLeaseDurationMs = options?.claimLeaseDurationMs ?? 15000;
    this.maxProcessingAttempts = options?.maxProcessingAttempts ?? 3;
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Atomically claims the oldest pending event or expired processing event using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Increments attempt count and generates a fresh durable claim token.
   * Expired processing events exceeding maxProcessingAttempts are transitioned to FAILED.
   */
  async claimNextPendingEvent(options?: {
    leaseDurationMs?: number | undefined;
    maxAttempts?: number | undefined;
  }): Promise<ClaimedEvent | null> {
    const leaseDurationMs = options?.leaseDurationMs ?? this.claimLeaseDurationMs;
    const maxAttempts = options?.maxAttempts ?? this.maxProcessingAttempts;
    const newClaimToken = randomUUID();

    // 1. Transition expired claims that have exhausted attempts to FAILED
    await this.db.$executeRaw`
      UPDATE intrusion_events
      SET
        status = 'FAILED',
        processing_claim_token = NULL,
        processing_lease_expires_at = NULL,
        updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND processing_lease_expires_at < NOW()
        AND processing_attempt_count >= ${maxAttempts}
        AND NOT EXISTS (
          SELECT 1 FROM deception_decisions WHERE event_id = intrusion_events.id
        )
    `;

    // 2. Atomically claim candidate with FOR UPDATE SKIP LOCKED
    const claimed = await this.db.$queryRaw<RawIntrusionEventRow[]>`
      UPDATE intrusion_events
      SET
        status = 'PROCESSING',
        processing_claim_token = ${newClaimToken}::uuid,
        processing_lease_expires_at = NOW() + (${leaseDurationMs} || ' milliseconds')::interval,
        processing_attempt_count = processing_attempt_count + 1,
        updated_at = NOW()
      WHERE id = (
        SELECT id FROM intrusion_events
        WHERE (
          status = 'PENDING'
          OR (
            status = 'PROCESSING'
            AND processing_lease_expires_at < NOW()
            AND processing_attempt_count < ${maxAttempts}
          )
        )
        ORDER BY received_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id,
        occurred_at,
        received_at,
        correlation_id,
        source_ip,
        target_asset,
        event_type,
        failed_login_count,
        risk_indicators,
        containment_mode,
        used_decoy_credential,
        decoy_identifier,
        status,
        provenance,
        processing_claim_token,
        processing_lease_expires_at,
        processing_attempt_count;
    `;

    if (!claimed || claimed.length === 0 || !claimed[0]) {
      return null;
    }

    const row = claimed[0];

    const rawEvent = {
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      correlationId: row.correlation_id,
      sourceIp: row.source_ip,
      targetAsset: row.target_asset,
      eventType: row.event_type,
      failedLoginCount: row.failed_login_count,
      riskIndicators: row.risk_indicators,
      containmentMode: row.containment_mode,
      usedDecoyCredential: row.used_decoy_credential,
      decoyIdentifier: row.decoy_identifier ?? undefined,
      status: 'PROCESSING' as const,
      provenance: 'OBSERVED' as const,
    };

    return {
      event: IntrusionEventSchema.parse(rawEvent),
      claimToken: row.processing_claim_token ?? newClaimToken,
    };
  }

  /**
   * Persists the deterministic decision, audit record, optional simulated effect, and updates event status to DECIDED in one transaction.
   * Enforces fencing: verifies matching claimToken, status = 'PROCESSING', and non-expired lease.
   */
  async persistDecision(
    decision: DeceptionDecision,
    claimToken: string,
    simulatedEffect?: SimulatedDeceptionEffect | undefined,
  ): Promise<void> {
    if (decision.action === 'ASSIGN_FALSE_ROUTE') {
      if (!simulatedEffect) {
        throw new Error(
          `Invariant violation: ASSIGN_FALSE_ROUTE decision requires a matching simulatedEffect record`,
        );
      }
      if (
        simulatedEffect.decisionId !== decision.id ||
        simulatedEffect.correlationId !== decision.correlationId
      ) {
        throw new Error(
          `Invariant violation: simulatedEffect IDs do not match decision for event ${decision.eventId}`,
        );
      }
    } else if (simulatedEffect) {
      throw new Error(
        `Invariant violation: non-route action "${decision.action}" must not have a simulatedEffect record`,
      );
    }

    const assignedFalseRoute =
      'assignedFalseRoute' in decision ? (decision.assignedFalseRoute ?? null) : null;

    await this.db.$transaction(async (tx) => {
      const updatedCount = await tx.$executeRaw`
        UPDATE intrusion_events
        SET
          status = 'DECIDED',
          processing_claim_token = NULL,
          processing_lease_expires_at = NULL,
          updated_at = NOW()
        WHERE id = ${decision.eventId}
          AND status = 'PROCESSING'
          AND processing_claim_token = ${claimToken}::uuid
          AND processing_lease_expires_at >= NOW()
      `;

      if (updatedCount === 0) {
        throw new Error(
          `Claim fencing violation: cannot persist decision for event ${decision.eventId} (claim token stale, expired, or state already terminal)`,
        );
      }

      await tx.deceptionDecision.create({
        data: {
          id: decision.id,
          eventId: decision.eventId,
          correlationId: decision.correlationId,
          action: decision.action as DeceptionAction,
          assignedFalseRoute,
          matchedPolicy: decision.matchedPolicy,
          reason: decision.reason,
          containmentMode: decision.containmentMode as ContainmentMode,
          decisionProvenance: decision.decisionProvenance as ProvenanceClassification,
          decidedAt: new Date(decision.decidedAt),
          modelEnrichment: decision.modelEnrichment
            ? JSON.parse(JSON.stringify(decision.modelEnrichment))
            : undefined,
          auditRecord: {
            create: {
              id: randomUUID(),
              ruleVersion: decision.auditRecord.ruleVersion,
              evaluatedAt: new Date(decision.auditRecord.evaluatedAt),
            },
          },
          ...(simulatedEffect
            ? {
                simulatedEffect: {
                  create: {
                    id: simulatedEffect.id,
                    correlationId: simulatedEffect.correlationId,
                    effectKind: simulatedEffect.effectKind,
                    status: simulatedEffect.status,
                    containmentMode: simulatedEffect.containmentMode as ContainmentMode,
                    assignedFalseRoute: simulatedEffect.assignedFalseRoute,
                    provenance: simulatedEffect.provenance as ProvenanceClassification,
                    recordedAt: new Date(simulatedEffect.recordedAt),
                    adapterVersion: simulatedEffect.adapterVersion,
                  },
                },
              }
            : {}),
        },
      });
    });
  }

  /**
   * Claim-aware failure handler. Atomically releases or fails a claimed event.
   * If a decision exists, does not change terminal status (returns ALREADY_DECIDED).
   * If claim is stale, does nothing (returns STALE_CLAIM).
   * If attempts remain, resets to PENDING (returns REQUEUED).
   * If attempts exhausted, sets FAILED (returns FAILED).
   */
  async releaseOrFailClaim(
    eventId: string,
    claimToken: string,
    options?: { maxAttempts?: number | undefined },
  ): Promise<ClaimReleaseOutcome> {
    return this.db.$transaction(async (tx) => {
      const existingDecisions = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM deception_decisions WHERE event_id = ${eventId} LIMIT 1
      `;
      if (existingDecisions.length > 0) {
        return 'ALREADY_DECIDED' as const;
      }

      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          processing_claim_token: string | null;
          processing_attempt_count: number;
        }[]
      >`
        SELECT id, status, processing_claim_token, processing_attempt_count
        FROM intrusion_events
        WHERE id = ${eventId}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return 'STALE_CLAIM' as const;
      }

      const row = rows[0]!;
      if (row.status !== 'PROCESSING' || row.processing_claim_token !== claimToken) {
        return 'STALE_CLAIM' as const;
      }

      const attempts = row.processing_attempt_count;
      const maxAttempts = options?.maxAttempts ?? this.maxProcessingAttempts;

      if (attempts < maxAttempts) {
        await tx.$executeRaw`
          UPDATE intrusion_events
          SET
            status = 'PENDING',
            processing_claim_token = NULL,
            processing_lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = ${eventId}
        `;
        return 'REQUEUED' as const;
      } else {
        await tx.$executeRaw`
          UPDATE intrusion_events
          SET
            status = 'FAILED',
            processing_claim_token = NULL,
            processing_lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = ${eventId}
        `;
        return 'FAILED' as const;
      }
    });
  }
}
