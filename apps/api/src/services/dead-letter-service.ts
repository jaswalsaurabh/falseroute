import {
  IntrusionEventEnvelopeSchema,
  type IntrusionEventEnvelope,
  type DeadLetterInspectionRecord,
  type ReplayDeadLetterResponse,
} from '@false-route/contracts';
import { type AutonomousWorkflowRepository } from '@false-route/database';
import { type EventPublisher } from '../integrations/event-publisher.js';

export class DeadLetterService {
  private readonly memoryRecords: Map<string, DeadLetterInspectionRecord> = new Map();

  constructor(
    private readonly workflowRepo?: AutonomousWorkflowRepository,
    private readonly eventPublisher?: EventPublisher,
  ) {}

  addRecord(record: DeadLetterInspectionRecord): void {
    this.memoryRecords.set(record.deadLetterId, record);
  }

  async listRecords(params?: {
    replayStatus?: string;
    limit?: number;
  }): Promise<DeadLetterInspectionRecord[]> {
    if (this.workflowRepo) {
      const dbRecords = await this.workflowRepo.listDeadLetters(params);
      return dbRecords.map((r) => ({
        deadLetterId: r.id,
        originalMessageId: r.originalMessageId,
        originalEventId: r.originalEventId ?? null,
        failedAt: r.quarantinedAt.toISOString(),
        failureReason: r.failureReason,
        retryCount: r.retryCount,
        payload: r.payload,
        replayStatus: r.replayStatus as DeadLetterInspectionRecord['replayStatus'],
      }));
    }
    return Array.from(this.memoryRecords.values());
  }

  async getRecord(id: string): Promise<DeadLetterInspectionRecord | undefined> {
    if (this.workflowRepo) {
      const dbRecord = await this.workflowRepo.getDeadLetterById(id);
      if (dbRecord) {
        return {
          deadLetterId: dbRecord.id,
          originalMessageId: dbRecord.originalMessageId,
          originalEventId: dbRecord.originalEventId ?? null,
          failedAt: dbRecord.quarantinedAt.toISOString(),
          failureReason: dbRecord.failureReason,
          retryCount: dbRecord.retryCount,
          payload: dbRecord.payload,
          replayStatus: dbRecord.replayStatus as DeadLetterInspectionRecord['replayStatus'],
        };
      }
    }
    return this.memoryRecords.get(id);
  }

  async replayRecord(
    deadLetterId: string,
    requestedBy: string,
    rationale: string,
  ): Promise<ReplayDeadLetterResponse> {
    if (!requestedBy || requestedBy.trim().length === 0) {
      throw new Error('Replay request requires elevated operator identity');
    }

    if (!rationale || rationale.trim().length < 5) {
      throw new Error('Replay request requires a detailed operational rationale');
    }

    const record = await this.getRecord(deadLetterId);
    if (!record) {
      throw new Error(`Dead letter record ${deadLetterId} not found`);
    }

    if (record.replayStatus !== 'AVAILABLE') {
      throw new Error(
        `Dead letter record ${deadLetterId} is not available for replay (${record.replayStatus})`,
      );
    }

    if (!this.eventPublisher) {
      throw new Error('Event publisher is not configured for replay delivery');
    }
    if (!this.workflowRepo) {
      throw new Error('Durable replay ownership is not configured');
    }
    if (!record.originalEventId) {
      throw new Error('Schema-invalid poison messages cannot be replayed as intrusion events');
    }
    const envelope = IntrusionEventEnvelopeSchema.parse(record.payload) as IntrusionEventEnvelope;
    if (envelope.eventId !== record.originalEventId) {
      throw new Error('Dead-letter payload event identity does not match its durable record');
    }

    const claim = await this.workflowRepo.claimDeadLetterForReplay({
      deadLetterId,
      requestedBy,
      rationale,
    });
    if (!claim.claimed || !claim.replayAttempt) {
      throw new Error(`Dead letter record ${deadLetterId} is already claimed or terminal`);
    }

    let publishResult: { transportId: string };
    try {
      publishResult = await this.eventPublisher.publish(envelope);
    } catch (err) {
      await this.workflowRepo.failReplayClaim({
        replayAttemptId: claim.replayAttempt.id,
        reason: `Replay transport publish failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    let completed: Awaited<ReturnType<AutonomousWorkflowRepository['completeReplayClaim']>>;
    try {
      completed = await this.workflowRepo.completeReplayClaim({
        replayAttemptId: claim.replayAttempt.id,
        newTransportId: publishResult.transportId,
      });
    } catch (err) {
      await this.workflowRepo
        .failReplayClaim({
          replayAttemptId: claim.replayAttempt.id,
          reason: `Replay published as ${publishResult.transportId}; completion requires reconciliation`,
        })
        .catch(() => undefined);
      throw new Error(
        'Replay was published but durable completion requires operator reconciliation',
        {
          cause: err,
        },
      );
    }

    return {
      replayId: completed.id,
      originalEventId: record.originalEventId,
      newTransportId: publishResult.transportId,
      replayedAt: (completed.completedAt ?? new Date()).toISOString(),
      status: 'ACCEPTED',
    };
  }
}
