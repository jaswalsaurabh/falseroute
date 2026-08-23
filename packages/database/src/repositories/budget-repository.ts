import {
  Prisma,
  type PrismaClient,
  type BudgetCategory,
  type BudgetReservationStatus,
} from '../generated/client/client.js';

export interface BudgetReservationInput {
  readonly idempotencyKey: string;
  readonly category: BudgetCategory;
  readonly windowKey: string;
  readonly amountReserved: number;
  readonly limit: number;
  readonly ownerId: string;
  readonly ttlMs?: number | undefined;
  readonly eventId?: string | undefined;
}

export interface BudgetReservationSuccess {
  readonly granted: true;
  readonly isDuplicate: boolean;
  readonly reservation: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly category: BudgetCategory;
    readonly windowKey: string;
    readonly amountReserved: number;
    readonly amountConsumed?: number | null | undefined;
    readonly status: BudgetReservationStatus;
    readonly ownerId: string;
    readonly expiresAt: Date;
    readonly eventId?: string | null | undefined;
    readonly version: number;
  };
}

export interface BudgetReservationFailure {
  readonly granted: false;
  readonly isDuplicate: boolean;
  readonly reason: string;
  readonly currentCommitted: number;
  readonly limit: number;
}

export type BudgetReservationOutcome = BudgetReservationSuccess | BudgetReservationFailure;

/**
 * Evidence recorded against a single model-call reservation. `DISPATCHED` is written immediately
 * before the provider request leaves the process; `PRE_CALL_FAILED` only when non-dispatch was
 * verified. Absence of a value is *not* evidence of non-dispatch.
 *
 * Mirrors the `GeminiAttemptOutcome` contract; this package intentionally has no dependency on
 * `@false-route/contracts`, exactly as it mirrors `BudgetCategory` from the generated client.
 */
export interface GeminiAttemptEvidenceInput {
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly outcome: 'DISPATCHED' | 'PRE_CALL_FAILED';
  readonly expectedVersion?: number;
}

export interface EventAttemptSlotInput {
  readonly eventId: string;
  readonly category: BudgetCategory;
  readonly windowKey: string;
  readonly amountReserved: number;
  readonly limit: number;
  readonly ownerId: string;
  readonly maxAttempts: number;
  readonly idempotencyKeyPrefix: string;
  readonly ttlMs?: number | undefined;
}

export interface EventAttemptSlotSuccess extends BudgetReservationSuccess {
  readonly attemptNumber: number;
}

export type EventAttemptSlotOutcome = EventAttemptSlotSuccess | BudgetReservationFailure;

const ATTEMPT_COUNTING_STATUSES = new Set<BudgetReservationStatus>([
  'RESERVED',
  'CONSUMED',
  'RECONCILED',
]);

export interface BudgetStatusResult {
  readonly category: BudgetCategory;
  readonly windowKey: string;
  readonly limit: number;
  readonly totalConsumed: number;
  readonly totalActiveReserved: number;
  readonly totalCommitted: number;
  readonly remainingAvailable: number;
  readonly isExceeded: boolean;
}

function validateNumericPositive(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a finite number greater than zero`);
  }
}

function validateNumericNonNegative(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: must be a finite non-negative number`);
  }
}

async function sumCommittedInWindow(
  tx: Prisma.TransactionClient,
  category: BudgetCategory,
  windowKey: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ consumed: string | null; reserved: string | null }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('CONSUMED', 'RECONCILED') THEN COALESCE(amount_consumed, amount_reserved) ELSE 0 END), 0)::text AS consumed,
      COALESCE(SUM(CASE WHEN status = 'RESERVED' AND expires_at > NOW() THEN amount_reserved ELSE 0 END), 0)::text AS reserved
    FROM budget_reservation_records
    WHERE category = ${category}::"BudgetCategory"
      AND window_key = ${windowKey}
      AND (
        status IN ('CONSUMED', 'RECONCILED')
        OR (status = 'RESERVED' AND expires_at > NOW())
      )
  `;

  return Number.parseFloat(rows[0]?.consumed ?? '0') + Number.parseFloat(rows[0]?.reserved ?? '0');
}

export class BudgetRepository {
  constructor(protected readonly budgetPrisma: PrismaClient) {}

  async reserveBudget(params: BudgetReservationInput): Promise<BudgetReservationOutcome> {
    validateNumericPositive(params.amountReserved, 'amountReserved');
    validateNumericPositive(params.limit, 'limit');

    const ttlMs = params.ttlMs ?? 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const amountToReserve = new Prisma.Decimal(params.amountReserved);

    return this.budgetPrisma.$transaction(async (tx) => {
      // 1. Acquire transaction-scoped advisory lock on (category, windowKey) first
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${params.category} || ':' || ${params.windowKey}))
      `;

      // 2. Check existing reservation by idempotency key
      const existing = await tx.budgetReservationRecord.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });

      if (existing) {
        if (
          existing.category !== params.category ||
          existing.windowKey !== params.windowKey ||
          !existing.amountReserved.equals(amountToReserve) ||
          existing.eventId !== (params.eventId ?? null)
        ) {
          throw new Error('Budget reservation idempotency collision with mismatched parameters');
        }

        // Check existing reservation status:
        if (existing.status === 'RESERVED') {
          if (existing.expiresAt <= new Date()) {
            return {
              granted: false as const,
              isDuplicate: true,
              reason: `Reservation ${params.idempotencyKey} has expired (status RESERVED, expired at ${existing.expiresAt.toISOString()})`,
              currentCommitted: params.limit,
              limit: params.limit,
            };
          }

          if (existing.ownerId !== params.ownerId) {
            return {
              granted: false as const,
              isDuplicate: true,
              reason: `Reservation ${params.idempotencyKey} is actively held by another claim owner`,
              currentCommitted: params.limit,
              limit: params.limit,
            };
          }

          return {
            granted: true as const,
            isDuplicate: true,
            reservation: {
              id: existing.id,
              idempotencyKey: existing.idempotencyKey,
              category: existing.category,
              windowKey: existing.windowKey,
              amountReserved: existing.amountReserved.toNumber(),
              amountConsumed: existing.amountConsumed ? existing.amountConsumed.toNumber() : null,
              status: existing.status,
              ownerId: existing.ownerId,
              expiresAt: existing.expiresAt,
              eventId: existing.eventId,
              version: existing.version,
            },
          };
        }

        if (existing.status === 'CONSUMED') {
          return {
            granted: false as const,
            isDuplicate: true,
            reason: `Reservation ${params.idempotencyKey} is already CONSUMED and cannot be granted again`,
            currentCommitted: params.limit,
            limit: params.limit,
          };
        }

        return {
          granted: false as const,
          isDuplicate: true,
          reason: `Reservation ${params.idempotencyKey} is in terminal status ${existing.status} and cannot be granted again`,
          currentCommitted: params.limit,
          limit: params.limit,
        };
      }

      // 3. Durable event call limit check for DAILY_GEMINI_TOKENS (max 2 calls per event)
      if (params.eventId && params.category === 'DAILY_GEMINI_TOKENS') {
        const eventReservationsCount = await tx.budgetReservationRecord.count({
          where: {
            eventId: params.eventId,
            category: 'DAILY_GEMINI_TOKENS',
            status: { in: ['RESERVED', 'CONSUMED', 'RECONCILED'] },
          },
        });
        if (eventReservationsCount >= 2) {
          return {
            granted: false as const,
            isDuplicate: false,
            reason: `Durable Gemini model call limit exceeded: event ${params.eventId} already has ${eventReservationsCount} active or committed reservations (maximum 2 calls per event)`,
            currentCommitted: params.limit,
            limit: params.limit,
          };
        }
      }

      // 4. Compute active committed total (CONSUMED + RECONCILED + active unexpired RESERVED)
      const totalCommitted = await sumCommittedInWindow(tx, params.category, params.windowKey);

      if (totalCommitted + params.amountReserved > params.limit) {
        return {
          granted: false as const,
          isDuplicate: false,
          reason: `Durable budget ceiling exceeded for category ${params.category}: committed ${totalCommitted.toFixed(2)} + requested ${params.amountReserved} > limit ${params.limit.toFixed(2)}`,
          currentCommitted: totalCommitted,
          limit: params.limit,
        };
      }

      // 5. Create fresh durable reservation
      const created = await tx.budgetReservationRecord.create({
        data: {
          idempotencyKey: params.idempotencyKey,
          category: params.category,
          windowKey: params.windowKey,
          amountReserved: amountToReserve,
          status: 'RESERVED',
          ownerId: params.ownerId,
          expiresAt,
          eventId: params.eventId ?? null,
          version: 1,
        },
      });

      return {
        granted: true as const,
        isDuplicate: false,
        reservation: {
          id: created.id,
          idempotencyKey: created.idempotencyKey,
          category: created.category,
          windowKey: created.windowKey,
          amountReserved: created.amountReserved.toNumber(),
          amountConsumed: null,
          status: created.status,
          ownerId: created.ownerId,
          expiresAt: created.expiresAt,
          eventId: created.eventId,
          version: created.version,
        },
      };
    });
  }

  /**
   * Atomically claims the next free per-event model-call attempt slot and reserves budget for it.
   *
   * The attempt number is derived inside the same advisory-locked transaction that enforces the
   * per-event cap, so it can never be supplied or raced by a caller. The lock is keyed on
   * (category, windowKey) — identical to `reserveBudget` — which serialises every competing worker
   * for the same event because an event's attempts always share one budget window.
   *
   * A slot is never re-used once any row exists for it, even a RELEASED one. That is deliberately
   * conservative: it keeps idempotency keys collision-free and can only ever reduce, never inflate,
   * the number of provider calls an event may make.
   */
  async acquireEventAttemptSlot(params: EventAttemptSlotInput): Promise<EventAttemptSlotOutcome> {
    validateNumericPositive(params.amountReserved, 'amountReserved');
    validateNumericPositive(params.limit, 'limit');
    if (!Number.isInteger(params.maxAttempts) || params.maxAttempts < 1) {
      throw new Error('Invalid maxAttempts: must be an integer greater than zero');
    }

    const ttlMs = params.ttlMs ?? 60_000;
    const amountToReserve = new Prisma.Decimal(params.amountReserved);

    return this.budgetPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${params.category} || ':' || ${params.windowKey}))
      `;

      const existingRows = await tx.budgetReservationRecord.findMany({
        where: { eventId: params.eventId, category: params.category },
      });

      // Idempotent replay: this owner already holds a live reservation for this event.
      const heldByOwner = existingRows.find(
        (row) =>
          row.ownerId === params.ownerId &&
          row.status === 'RESERVED' &&
          row.expiresAt > new Date() &&
          row.idempotencyKey.startsWith(`${params.idempotencyKeyPrefix}:attempt-`),
      );

      if (heldByOwner) {
        return {
          granted: true as const,
          isDuplicate: true,
          attemptNumber: Number.parseInt(
            heldByOwner.idempotencyKey.split('attempt-')[1] ?? '0',
            10,
          ),
          reservation: {
            id: heldByOwner.id,
            idempotencyKey: heldByOwner.idempotencyKey,
            category: heldByOwner.category,
            windowKey: heldByOwner.windowKey,
            amountReserved: heldByOwner.amountReserved.toNumber(),
            amountConsumed: heldByOwner.amountConsumed
              ? heldByOwner.amountConsumed.toNumber()
              : null,
            status: heldByOwner.status,
            ownerId: heldByOwner.ownerId,
            expiresAt: heldByOwner.expiresAt,
            eventId: heldByOwner.eventId,
            version: heldByOwner.version,
          },
        };
      }

      const chargedAttempts = existingRows.filter((row) =>
        ATTEMPT_COUNTING_STATUSES.has(row.status),
      ).length;

      if (chargedAttempts >= params.maxAttempts) {
        return {
          granted: false as const,
          isDuplicate: false,
          reason: `Durable model attempt limit exceeded: event ${params.eventId} already has ${chargedAttempts} of ${params.maxAttempts} accounted ${params.category} attempts`,
          currentCommitted: params.limit,
          limit: params.limit,
        };
      }

      const takenKeys = new Set(existingRows.map((row) => row.idempotencyKey));
      let attemptNumber = 0;
      for (let candidate = 1; candidate <= params.maxAttempts; candidate += 1) {
        if (!takenKeys.has(`${params.idempotencyKeyPrefix}:attempt-${candidate}`)) {
          attemptNumber = candidate;
          break;
        }
      }

      if (attemptNumber === 0) {
        return {
          granted: false as const,
          isDuplicate: false,
          reason: `Durable model attempt limit exceeded: event ${params.eventId} has no free attempt slot within ${params.maxAttempts}`,
          currentCommitted: params.limit,
          limit: params.limit,
        };
      }

      const totalCommitted = await sumCommittedInWindow(tx, params.category, params.windowKey);
      if (totalCommitted + params.amountReserved > params.limit) {
        return {
          granted: false as const,
          isDuplicate: false,
          reason: `Durable budget ceiling exceeded for category ${params.category}: committed ${totalCommitted.toFixed(2)} + requested ${params.amountReserved} > limit ${params.limit.toFixed(2)}`,
          currentCommitted: totalCommitted,
          limit: params.limit,
        };
      }

      const created = await tx.budgetReservationRecord.create({
        data: {
          idempotencyKey: `${params.idempotencyKeyPrefix}:attempt-${attemptNumber}`,
          category: params.category,
          windowKey: params.windowKey,
          amountReserved: amountToReserve,
          status: 'RESERVED',
          ownerId: params.ownerId,
          expiresAt: new Date(Date.now() + ttlMs),
          eventId: params.eventId,
          version: 1,
        },
      });

      return {
        granted: true as const,
        isDuplicate: false,
        attemptNumber,
        reservation: {
          id: created.id,
          idempotencyKey: created.idempotencyKey,
          category: created.category,
          windowKey: created.windowKey,
          amountReserved: created.amountReserved.toNumber(),
          amountConsumed: null,
          status: created.status,
          ownerId: created.ownerId,
          expiresAt: created.expiresAt,
          eventId: created.eventId,
          version: created.version,
        },
      };
    });
  }

  /**
   * Records what is durably known about this reservation's own provider attempt.
   *
   * Deliberately does not bump `version`: the caller still owns the reservation and must be able to
   * settle it with the version it already fenced on. The owner/status guards are the CAS here.
   */
  async recordGeminiAttemptOutcome(params: GeminiAttemptEvidenceInput): Promise<void> {
    const result = await this.budgetPrisma.budgetReservationRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        ownerId: params.ownerId,
        status: 'RESERVED',
        ...(params.expectedVersion !== undefined ? { version: params.expectedVersion } : {}),
      },
      data: { geminiAttemptOutcome: params.outcome },
    });

    if (result.count !== 1) {
      throw new Error(
        `Failed to record model attempt outcome for ${params.idempotencyKey}: reservation missing, not owned, or concurrently modified`,
      );
    }
  }

  async consumeBudget(params: {
    idempotencyKey: string;
    ownerId: string;
    amountConsumed: number;
    expectedVersion?: number;
    expectedStatus?: BudgetReservationStatus;
  }) {
    validateNumericNonNegative(params.amountConsumed, 'amountConsumed');
    const consumedDecimal = new Prisma.Decimal(params.amountConsumed);

    const existing = await this.budgetPrisma.budgetReservationRecord.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (!existing) {
      throw new Error(`Budget reservation ${params.idempotencyKey} not found`);
    }

    if (params.amountConsumed > existing.amountReserved.toNumber()) {
      throw new Error(
        `Amount consumed (${params.amountConsumed}) cannot exceed amount reserved (${existing.amountReserved.toNumber()})`,
      );
    }

    if (existing.ownerId !== params.ownerId) {
      throw new Error(
        `Stale reservation owner: expected ${params.ownerId} but found ${existing.ownerId}`,
      );
    }

    const expectedStatus = params.expectedStatus ?? 'RESERVED';
    if (existing.status !== expectedStatus) {
      throw new Error(
        `Invalid reservation status: expected ${expectedStatus} but found ${existing.status}`,
      );
    }

    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new Error(
        `Stale reservation version: expected ${params.expectedVersion} but found ${existing.version}`,
      );
    }

    const result = await this.budgetPrisma.budgetReservationRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        ownerId: params.ownerId,
        status: expectedStatus,
        version: existing.version,
      },
      data: {
        status: 'CONSUMED',
        amountConsumed: consumedDecimal,
        consumedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      throw new Error(
        `Failed to consume budget reservation ${params.idempotencyKey}: concurrent modification or fence lost`,
      );
    }

    return this.budgetPrisma.budgetReservationRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
  }

  async releaseBudget(params: {
    idempotencyKey: string;
    ownerId: string;
    expectedVersion?: number;
    expectedStatus?: BudgetReservationStatus;
  }) {
    const existing = await this.budgetPrisma.budgetReservationRecord.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (!existing) {
      throw new Error(`Budget reservation ${params.idempotencyKey} not found`);
    }

    if (existing.ownerId !== params.ownerId) {
      throw new Error(
        `Stale reservation owner: expected ${params.ownerId} but found ${existing.ownerId}`,
      );
    }

    const expectedStatus = params.expectedStatus ?? 'RESERVED';
    if (existing.status !== expectedStatus) {
      throw new Error(
        `Invalid reservation status: expected ${expectedStatus} but found ${existing.status}`,
      );
    }

    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new Error(
        `Stale reservation version: expected ${params.expectedVersion} but found ${existing.version}`,
      );
    }

    const result = await this.budgetPrisma.budgetReservationRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        ownerId: params.ownerId,
        status: expectedStatus,
        version: existing.version,
      },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      throw new Error(
        `Failed to release budget reservation ${params.idempotencyKey}: concurrent modification or fence lost`,
      );
    }

    return this.budgetPrisma.budgetReservationRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
  }

  async reconcileBudgetReservation(params: {
    idempotencyKey: string;
    amountConsumed: number;
    expectedVersion?: number;
    asOf?: Date;
  }) {
    validateNumericNonNegative(params.amountConsumed, 'amountConsumed');
    const consumedDecimal = new Prisma.Decimal(params.amountConsumed);
    const asOf = params.asOf ?? new Date();

    const existing = await this.budgetPrisma.budgetReservationRecord.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (!existing) {
      throw new Error(`Budget reservation ${params.idempotencyKey} not found`);
    }

    if (params.amountConsumed > existing.amountReserved.toNumber()) {
      throw new Error(
        `Reconciled amount (${params.amountConsumed}) cannot exceed amount reserved (${existing.amountReserved.toNumber()})`,
      );
    }

    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new Error(
        `Stale reservation version: expected ${params.expectedVersion} but found ${existing.version}`,
      );
    }

    const result = await this.budgetPrisma.budgetReservationRecord.updateMany({
      where: {
        idempotencyKey: params.idempotencyKey,
        version: existing.version,
      },
      data: {
        status: 'RECONCILED',
        amountConsumed: consumedDecimal,
        reconciledAt: asOf,
        version: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      throw new Error(
        `Failed to reconcile budget reservation ${params.idempotencyKey}: concurrent modification`,
      );
    }

    return this.budgetPrisma.budgetReservationRecord.findUniqueOrThrow({
      where: { idempotencyKey: params.idempotencyKey },
    });
  }

  async reconcileExpiredReservations(asOf = new Date()): Promise<number> {
    const expired = await this.budgetPrisma.budgetReservationRecord.findMany({
      where: {
        status: 'RESERVED',
        expiresAt: { lte: asOf },
      },
    });

    if (expired.length === 0) {
      return 0;
    }

    const updateResults = await Promise.all(
      expired.map(async (record) => {
        let shouldExpire = false;
        if (record.category === 'DAILY_GEMINI_TOKENS') {
          // Only evidence recorded against this reservation's own attempt may free its spend.
          // Tool provider intents (Cloud Run, route, quarantine) and deception decisions say
          // nothing about whether the model request was dispatched, so they are never consulted
          // here. Absence of evidence is treated as spent, not as proof of non-dispatch.
          shouldExpire = record.geminiAttemptOutcome === 'PRE_CALL_FAILED';
        } else if (record.eventId) {
          const intents = await this.budgetPrisma.providerIntentRecord.findMany({
            where: { eventId: record.eventId },
          });
          const hasExecutedOrAmbiguous = intents.some(
            (i) => i.status === 'EXECUTED' || i.status === 'CLAIMED',
          );
          if (
            !hasExecutedOrAmbiguous &&
            intents.length > 0 &&
            intents.every((i) => i.status === 'FAILED')
          ) {
            shouldExpire = true;
          } else if (intents.length === 0) {
            const decision = await this.budgetPrisma.deceptionDecision.findUnique({
              where: { eventId: record.eventId },
            });
            if (!decision) {
              shouldExpire = true;
            }
          }
        } else {
          shouldExpire = true;
        }

        if (shouldExpire) {
          const updated = await this.budgetPrisma.budgetReservationRecord.updateMany({
            where: { id: record.id, version: record.version, status: 'RESERVED' },
            data: {
              status: 'EXPIRED',
              reconciledAt: asOf,
              version: { increment: 1 },
            },
          });
          return updated.count;
        }

        // Retain conservative committed spend: mark RECONCILED with amountConsumed = amountReserved
        const updated = await this.budgetPrisma.budgetReservationRecord.updateMany({
          where: { id: record.id, version: record.version, status: 'RESERVED' },
          data: {
            status: 'RECONCILED',
            amountConsumed: record.amountReserved,
            reconciledAt: asOf,
            version: { increment: 1 },
          },
        });
        return updated.count;
      }),
    );

    return updateResults.reduce((sum, count) => sum + count, 0);
  }

  async getBudgetStatus(params: {
    category: BudgetCategory;
    windowKey: string;
    limit: number;
    asOf?: Date | undefined;
  }): Promise<BudgetStatusResult> {
    validateNumericPositive(params.limit, 'limit');
    const asOf = params.asOf ?? new Date();

    const activeRows = await this.budgetPrisma.$queryRaw<
      { consumed: string | null; reserved: string | null }[]
    >`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('CONSUMED', 'RECONCILED') THEN COALESCE(amount_consumed, amount_reserved) ELSE 0 END), 0)::text AS consumed,
        COALESCE(SUM(CASE WHEN status = 'RESERVED' AND expires_at > ${asOf} THEN amount_reserved ELSE 0 END), 0)::text AS reserved
      FROM budget_reservation_records
      WHERE category = ${params.category}::"BudgetCategory"
        AND window_key = ${params.windowKey}
        AND (
          status IN ('CONSUMED', 'RECONCILED')
          OR (status = 'RESERVED' AND expires_at > ${asOf})
        )
    `;

    const totalConsumed = Number.parseFloat(activeRows[0]?.consumed ?? '0');
    const totalActiveReserved = Number.parseFloat(activeRows[0]?.reserved ?? '0');
    const totalCommitted = totalConsumed + totalActiveReserved;
    const remainingAvailable = Math.max(0, params.limit - totalCommitted);

    return {
      category: params.category,
      windowKey: params.windowKey,
      limit: params.limit,
      totalConsumed,
      totalActiveReserved,
      totalCommitted,
      remainingAvailable,
      isExceeded: totalCommitted >= params.limit,
    };
  }

  async countEventReservations(eventId: string, category: BudgetCategory): Promise<number> {
    return this.budgetPrisma.budgetReservationRecord.count({
      where: {
        eventId,
        category,
        status: { in: ['RESERVED', 'CONSUMED', 'RECONCILED'] },
      },
    });
  }
}
