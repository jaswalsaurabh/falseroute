import { randomUUID } from 'node:crypto';
import {
  type IntrusionEvent,
  type DeceptionDecision,
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
}

export interface WorkerRepository {
  claimNextPendingEvent(): Promise<IntrusionEvent | null>;
  persistDecision(decision: DeceptionDecision): Promise<void>;
  markEventFailed(eventId: string): Promise<void>;
}

export class PrismaWorkerRepository implements WorkerRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * Atomically claims the oldest pending event using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Safe for concurrent worker instances.
   */
  async claimNextPendingEvent(): Promise<IntrusionEvent | null> {
    const claimed = await this.db.$queryRaw<RawIntrusionEventRow[]>`
      UPDATE intrusion_events
      SET status = 'PROCESSING', updated_at = NOW()
      WHERE id = (
        SELECT id FROM intrusion_events
        WHERE status = 'PENDING'
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
        provenance;
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

    return IntrusionEventSchema.parse(rawEvent);
  }

  /**
   * Persists the deterministic decision, audit record, and updates event status to DECIDED in one transaction.
   * Duplicate decisions for the same event fail atomically on the unique event_id constraint.
   */
  async persistDecision(decision: DeceptionDecision): Promise<void> {
    const assignedFalseRoute =
      'assignedFalseRoute' in decision ? (decision.assignedFalseRoute ?? null) : null;

    await this.db.$transaction(async (tx) => {
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
        },
      });

      await tx.intrusionEvent.update({
        where: { id: decision.eventId },
        data: { status: 'DECIDED' },
      });
    });
  }

  /**
   * Marks an unrecoverable event as FAILED.
   */
  async markEventFailed(eventId: string): Promise<void> {
    await this.db.intrusionEvent.update({
      where: { id: eventId },
      data: { status: 'FAILED' },
    });
  }
}
