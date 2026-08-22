import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '../generated/client/client.js';
import { LeaseRepository } from './lease-repository.js';

export interface IngestionReceiptResult {
  readonly isDuplicate: boolean;
  readonly receipt: {
    readonly id: string;
    readonly eventId: string;
    readonly transportId: string;
    readonly source: string;
    readonly status: string;
    readonly receivedAt: Date;
  };
}

export interface ToolOperationReservation {
  readonly isExisting: boolean;
  readonly operation: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly eventId: string;
    readonly toolName: string;
    readonly inputHash: string;
    readonly stage: string;
    readonly authorized: boolean;
    readonly policyReason: string;
    readonly providerResourceId?: string | null | undefined;
    readonly observedState?: string | null | undefined;
  };
}

export interface ProviderIntentClaim {
  readonly disposition: 'CLAIMED' | 'ALREADY_EXECUTED' | 'RECONCILIATION_REQUIRED';
  readonly claimToken?: string;
  readonly intent: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly eventId: string;
    readonly operationType: string;
    readonly provider: string;
    readonly status: string;
    readonly result: unknown;
  };
}

export interface DeadLetterRecordItem {
  readonly id: string;
  readonly originalMessageId: string;
  readonly originalEventId?: string | null | undefined;
  readonly failureReason: string;
  readonly retryCount: number;
  readonly payload: Record<string, unknown>;
  readonly replayStatus: string;
  readonly quarantinedAt: Date;
  readonly createdAt: Date;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot hash a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Cannot hash unsupported value type: ${typeof value}`);
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class AutonomousWorkflowRepository extends LeaseRepository {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }

  async recordIngestionReceipt(params: {
    eventId: string;
    transportId: string;
    source: string;
    status?: string;
  }): Promise<IngestionReceiptResult> {
    try {
      const created = await this.prisma.ingestionReceipt.create({
        data: {
          eventId: params.eventId,
          transportId: params.transportId,
          source: params.source,
          receivedAt: new Date(),
          status: params.status ?? 'ACCEPTED',
        },
      });
      return { isDuplicate: false, receipt: created };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const existing = await this.prisma.ingestionReceipt.findUnique({
        where: {
          eventId_transportId: {
            eventId: params.eventId,
            transportId: params.transportId,
          },
        },
      });
      if (!existing) throw error;
      if (existing.source !== params.source) {
        throw new Error('Ingestion idempotency collision has a different source', {
          cause: error,
        });
      }
      return { isDuplicate: true, receipt: existing };
    }
  }

  async recordDeliveryAttempt(params: {
    eventId: string;
    transportId: string;
    workerId: string;
    attemptNumber: number;
    status: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'TERMINAL_FAILURE';
    errorMessage?: string;
  }) {
    return this.prisma.deliveryAttempt.create({
      data: {
        eventId: params.eventId,
        transportId: params.transportId,
        workerId: params.workerId,
        attemptNumber: params.attemptNumber,
        status: params.status,
        errorMessage: params.errorMessage ? params.errorMessage.slice(0, 512) : null,
        attemptedAt: new Date(),
      },
    });
  }

  async reserveToolOperation(params: {
    idempotencyKey: string;
    eventId: string;
    toolName: string;
    input: unknown;
    authorized: boolean;
    policyReason: string;
    initialStage?: string;
  }): Promise<ToolOperationReservation> {
    const inputHash = canonicalJsonSha256(params.input);
    try {
      const created = await this.prisma.toolOperationLedger.create({
        data: {
          idempotencyKey: params.idempotencyKey,
          eventId: params.eventId,
          toolName: params.toolName,
          inputHash,
          stage: params.initialStage ?? (params.authorized ? 'AUTHORIZED' : 'REJECTED'),
          authorized: params.authorized,
          policyReason: params.policyReason.slice(0, 500),
        },
      });
      return { isExisting: false, operation: created };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const existing = await this.prisma.toolOperationLedger.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (!existing) throw error;
      if (
        existing.eventId !== params.eventId ||
        existing.toolName !== params.toolName ||
        existing.inputHash !== inputHash ||
        existing.authorized !== params.authorized
      ) {
        throw new Error('Tool-operation idempotency collision has different immutable input', {
          cause: error,
        });
      }
      return { isExisting: true, operation: existing };
    }
  }

  async updateToolOperationStage(params: {
    idempotencyKey: string;
    stage: string;
    expectedPriorStage?: string;
    providerResourceId?: string;
    observedState?: string;
    details?: Record<string, unknown>;
  }) {
    const updated = await this.prisma.toolOperationLedger.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        ...(params.expectedPriorStage && { stage: params.expectedPriorStage }),
      },
      data: {
        stage: params.stage,
        ...(params.providerResourceId !== undefined && {
          providerResourceId: params.providerResourceId,
        }),
        ...(params.observedState !== undefined && { observedState: params.observedState }),
        ...(params.details !== undefined && {
          details: params.details as unknown as Prisma.InputJsonValue,
        }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error('Tool-operation stage changed concurrently');
    return this.prisma.toolOperationLedger.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
  }

  async claimProviderIntent(params: {
    idempotencyKey: string;
    eventId: string;
    operationType: string;
    provider: string;
    claimOwner: string;
    claimTtlMs?: number;
    payload?: Record<string, unknown>;
  }): Promise<ProviderIntentClaim> {
    try {
      await this.prisma.providerIntentRecord.create({
        data: {
          idempotencyKey: params.idempotencyKey,
          eventId: params.eventId,
          operationType: params.operationType,
          provider: params.provider,
          status: 'PENDING',
          payload: (params.payload as unknown as Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
    }

    const existing = await this.prisma.providerIntentRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (
      existing.eventId !== params.eventId ||
      existing.operationType !== params.operationType ||
      existing.provider !== params.provider
    ) {
      throw new Error('Provider-intent idempotency collision has different immutable input');
    }
    if (existing.status === 'EXECUTED') {
      return { disposition: 'ALREADY_EXECUTED', intent: existing };
    }
    if (existing.status !== 'PENDING') {
      return { disposition: 'RECONCILIATION_REQUIRED', intent: existing };
    }

    const claimToken = randomUUID();
    const claimed = await this.prisma.providerIntentRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        status: 'PENDING',
        version: existing.version,
      },
      data: {
        status: 'CLAIMED',
        claimOwner: params.claimOwner,
        claimToken,
        claimExpiresAt: new Date(Date.now() + (params.claimTtlMs ?? 60_000)),
        attemptCount: { increment: 1 },
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      const concurrent = await this.prisma.providerIntentRecord.findUniqueOrThrow({
        where: { idempotencyKey: params.idempotencyKey },
      });
      return { disposition: 'RECONCILIATION_REQUIRED', intent: concurrent };
    }
    const intent = await this.prisma.providerIntentRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
    return { disposition: 'CLAIMED', claimToken, intent };
  }

  async updateProviderIntentStatus(params: {
    idempotencyKey: string;
    claimToken: string;
    status: 'EXECUTED' | 'FAILED';
    result?: Record<string, unknown>;
  }) {
    const updated = await this.prisma.providerIntentRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        status: 'CLAIMED',
        claimToken: params.claimToken,
      },
      data: {
        status: params.status,
        ...(params.result !== undefined && {
          result: params.result as unknown as Prisma.InputJsonValue,
        }),
        claimExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error('Provider-intent claim was lost');
    return this.prisma.providerIntentRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
  }

  async recordDeadLetter(params: {
    originalMessageId: string;
    originalEventId?: string;
    failureReason: string;
    payload: Record<string, unknown>;
    retryCount?: number;
  }): Promise<DeadLetterRecordItem> {
    try {
      const created = await this.prisma.deadLetterRecord.create({
        data: {
          originalMessageId: params.originalMessageId,
          originalEventId: params.originalEventId ?? null,
          failureReason: params.failureReason.slice(0, 512),
          retryCount: params.retryCount ?? 0,
          payload: params.payload as unknown as Prisma.InputJsonValue,
          replayStatus: 'AVAILABLE',
        },
      });
      return created as unknown as DeadLetterRecordItem;
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const existing = await this.prisma.deadLetterRecord.findUnique({
        where: { originalMessageId: params.originalMessageId },
      });
      if (!existing) throw error;
      if (
        existing.originalEventId !== (params.originalEventId ?? null) ||
        canonicalJsonSha256(existing.payload) !== canonicalJsonSha256(params.payload)
      ) {
        throw new Error('Dead-letter message identity collision has different immutable input', {
          cause: error,
        });
      }
      return existing as unknown as DeadLetterRecordItem;
    }
  }

  async listDeadLetters(params?: {
    replayStatus?: string;
    limit?: number;
  }): Promise<DeadLetterRecordItem[]> {
    const records = await this.prisma.deadLetterRecord.findMany({
      where: {
        ...(params?.replayStatus && { replayStatus: params.replayStatus }),
      },
      orderBy: { quarantinedAt: 'desc' },
      take: Math.min(params?.limit ?? 50, 100),
    });

    return records as unknown as DeadLetterRecordItem[];
  }

  async getDeadLetterById(id: string): Promise<DeadLetterRecordItem | null> {
    const record = await this.prisma.deadLetterRecord.findUnique({
      where: { id },
    });

    return record as unknown as DeadLetterRecordItem | null;
  }

  async markDeadLetterReplayed(id: string) {
    return this.prisma.deadLetterRecord.update({
      where: { id },
      data: {
        replayStatus: 'REPLAYED',
      },
    });
  }

  async claimDeadLetterForReplay(params: {
    deadLetterId: string;
    requestedBy: string;
    rationale: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.deadLetterRecord.findUnique({
        where: { id: params.deadLetterId },
      });
      if (!record) throw new Error('Dead-letter record not found');
      if (!record.originalEventId) {
        throw new Error('Schema-invalid poison messages cannot be replayed as intrusion events');
      }
      const claimed = await transaction.deadLetterRecord.updateMany({
        where: { id: params.deadLetterId, replayStatus: 'AVAILABLE' },
        data: { replayStatus: 'REPLAYING' },
      });
      if (claimed.count !== 1) {
        return { claimed: false as const, record, replayAttempt: null };
      }
      const replayAttempt = await transaction.replayAttempt.create({
        data: {
          deadLetterId: record.id,
          originalEventId: record.originalEventId,
          originalTransportId: record.originalMessageId,
          requestedBy: params.requestedBy,
          rationale: params.rationale.slice(0, 512),
          status: 'CLAIMED',
        },
      });
      return {
        claimed: true as const,
        record: { ...record, replayStatus: 'REPLAYING' },
        replayAttempt,
      };
    });
  }

  async completeReplayClaim(params: { replayAttemptId: string; newTransportId: string }) {
    return this.prisma.$transaction(async (transaction) => {
      const attempt = await transaction.replayAttempt.findUniqueOrThrow({
        where: { id: params.replayAttemptId },
      });
      const completed = await transaction.replayAttempt.updateMany({
        where: { id: attempt.id, status: 'CLAIMED' },
        data: {
          status: 'COMPLETED',
          newTransportId: params.newTransportId,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) throw new Error('Replay claim is no longer active');
      await transaction.deadLetterRecord.update({
        where: { id: attempt.deadLetterId },
        data: { replayStatus: 'REPLAYED' },
      });
      return transaction.replayAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    });
  }

  async failReplayClaim(params: { replayAttemptId: string; reason: string }) {
    return this.prisma.$transaction(async (transaction) => {
      const attempt = await transaction.replayAttempt.findUniqueOrThrow({
        where: { id: params.replayAttemptId },
      });
      const failed = await transaction.replayAttempt.updateMany({
        where: { id: attempt.id, status: 'CLAIMED' },
        data: {
          status: 'FAILED',
          failureReason: params.reason.slice(0, 512),
          completedAt: new Date(),
        },
      });
      if (failed.count !== 1) throw new Error('Replay claim is no longer active');
      await transaction.deadLetterRecord.update({
        where: { id: attempt.deadLetterId },
        data: { replayStatus: 'REVIEW_REQUIRED' },
      });
      return transaction.replayAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    });
  }
}
