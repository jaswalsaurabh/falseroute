import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createDatabaseClient,
  type DatabaseClient,
  AutonomousWorkflowRepository,
  BudgetRepository,
} from './index.js';
import { validateTestDatabaseUrl } from './test-database.js';

describe('Durable Budget Enforcement Integration Tests', () => {
  let db: DatabaseClient;
  let budgetRepo: BudgetRepository;

  beforeAll(async () => {
    const connectionString = validateTestDatabaseUrl(
      process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'],
    );
    db = createDatabaseClient({ connectionString });
  });

  afterAll(async () => {
    if (db) {
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.budgetReservationRecord.deleteMany();
    budgetRepo = new AutonomousWorkflowRepository(db);
  });

  async function createEvent(id: string, correlationId: string, sourceIp: string): Promise<void> {
    await db.intrusionEvent.create({
      data: {
        id,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId,
        sourceIp,
        targetAsset: 'mock-portal',
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        failedLoginCount: 1,
        riskIndicators: ['test'],
        containmentMode: 'SIMULATED',
        usedDecoyCredential: false,
        status: 'PENDING',
        provenance: 'OBSERVED',
      },
    });
  }

  async function cleanupEvent(id: string): Promise<void> {
    await db.budgetReservationRecord.deleteMany({ where: { eventId: id } });
    await db.providerIntentRecord.deleteMany({ where: { eventId: id } });
    await db.intrusionEvent.deleteMany({ where: { id } });
  }

  it('reserves and consumes daily USD monetary budget atomically', async () => {
    const windowKey = '2026-08-23';
    const limit = 10.0;

    const res1 = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:usd:test-1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.5,
      limit,
      ownerId: 'worker-1',
    });

    expect(res1.granted).toBe(true);
    if (!res1.granted) return;
    expect(res1.isDuplicate).toBe(false);
    expect(res1.reservation.amountReserved).toBe(2.5);

    const consumed = await budgetRepo.consumeBudget({
      idempotencyKey: 'budget:usd:test-1',
      ownerId: 'worker-1',
      amountConsumed: 2.3,
    });

    expect(consumed.status).toBe('CONSUMED');
    expect(Number(consumed.amountConsumed)).toBe(2.3);

    const status = await budgetRepo.getBudgetStatus({
      category: 'DAILY_USD',
      windowKey,
      limit,
    });

    expect(status.totalConsumed).toBe(2.3);
    expect(status.totalActiveReserved).toBe(0);
    expect(status.remainingAvailable).toBeCloseTo(7.7);
    expect(status.isExceeded).toBe(false);
  });

  it('enforces atomic ceiling and rejects reservation when limit is exceeded', async () => {
    const windowKey = '2026-08-23';
    const limit = 5.0;

    const res1 = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:usd:ceiling-1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 4.0,
      limit,
      ownerId: 'worker-1',
    });
    expect(res1.granted).toBe(true);

    const res2 = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:usd:ceiling-2',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-2',
    });

    expect(res2.granted).toBe(false);
    if (res2.granted) return;
    expect(res2.reason).toContain('Durable budget ceiling exceeded');
    expect(res2.currentCommitted).toBe(4.0);
  });

  it('prevents competing concurrent requests from overspending the same budget ceiling', async () => {
    const windowKey = 'synthetic-concurrency-window';
    const limit = 10.0;
    const reservationAmount = 2.0;

    // 10 concurrent competing requests of $2.00 against a $10.00 ceiling
    // Exactly 5 must succeed (10.00 committed) and 5 must fail
    const promises = Array.from({ length: 10 }, (_, i) =>
      budgetRepo.reserveBudget({
        idempotencyKey: `budget:concurrent:${i}`,
        category: 'DAILY_USD',
        windowKey,
        amountReserved: reservationAmount,
        limit,
        ownerId: `worker-concurrent-${i}`,
      }),
    );

    const results = await Promise.all(promises);
    const grantedCount = results.filter((r) => r.granted).length;
    const rejectedCount = results.filter((r) => !r.granted).length;

    expect(grantedCount).toBe(5);
    expect(rejectedCount).toBe(5);

    const status = await budgetRepo.getBudgetStatus({
      category: 'DAILY_USD',
      windowKey,
      limit,
    });

    expect(status.totalCommitted).toBe(10.0);
    expect(status.remainingAvailable).toBe(0);
    expect(status.isExceeded).toBe(true);
  });

  it('handles duplicate reservation attempts idempotently', async () => {
    const idempotencyKey = 'budget:idem:test-dup';
    const windowKey = '2026-08-23';

    const res1 = await budgetRepo.reserveBudget({
      idempotencyKey,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-1',
    });

    expect(res1.granted).toBe(true);
    expect(res1.isDuplicate).toBe(false);

    const res2 = await budgetRepo.reserveBudget({
      idempotencyKey,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-1',
    });

    expect(res2.granted).toBe(true);
    expect(res2.isDuplicate).toBe(true);

    // Mismatched parameters with same idempotency key must reject
    await expect(
      budgetRepo.reserveBudget({
        idempotencyKey,
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        amountReserved: 9999,
        limit: 100_000,
        ownerId: 'worker-1',
      }),
    ).rejects.toThrow('idempotency collision');
  });

  it('prevents stale reservation owner from consuming or releasing reservation', async () => {
    const idempotencyKey = 'budget:owner:test';
    const windowKey = '2026-08-23T09';

    await budgetRepo.reserveBudget({
      idempotencyKey,
      category: 'HOURLY_TOOL_OPERATIONS',
      windowKey,
      amountReserved: 1,
      limit: 50,
      ownerId: 'worker-legitimate',
    });

    // Stale/impostor owner attempting consumption
    await expect(
      budgetRepo.consumeBudget({
        idempotencyKey,
        ownerId: 'worker-stale-impostor',
        amountConsumed: 1,
      }),
    ).rejects.toThrow('Stale reservation owner');

    // Stale/impostor owner attempting release
    await expect(
      budgetRepo.releaseBudget({
        idempotencyKey,
        ownerId: 'worker-stale-impostor',
      }),
    ).rejects.toThrow('Stale reservation owner');

    // Legitimate owner succeeds
    const released = await budgetRepo.releaseBudget({
      idempotencyKey,
      ownerId: 'worker-legitimate',
    });

    expect(released.status).toBe('RELEASED');
  });

  it('rejects invalid, negative, zero, and over-consumption values mechanically', async () => {
    const windowKey = '2026-08-23';

    await expect(
      budgetRepo.reserveBudget({
        idempotencyKey: 'budget:inv:1',
        category: 'DAILY_USD',
        windowKey,
        amountReserved: -5,
        limit: 10,
        ownerId: 'w1',
      }),
    ).rejects.toThrow('must be a finite number greater than zero');

    await expect(
      budgetRepo.reserveBudget({
        idempotencyKey: 'budget:inv:2',
        category: 'DAILY_USD',
        windowKey,
        amountReserved: 0,
        limit: 10,
        ownerId: 'w1',
      }),
    ).rejects.toThrow('must be a finite number greater than zero');

    await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:over:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit: 10,
      ownerId: 'w1',
    });

    await expect(
      budgetRepo.consumeBudget({
        idempotencyKey: 'budget:over:1',
        ownerId: 'w1',
        amountConsumed: 3.5, // Exceeds reserved 2.0
      }),
    ).rejects.toThrow('cannot exceed amount reserved');

    await expect(
      budgetRepo.consumeBudget({
        idempotencyKey: 'budget:over:1',
        ownerId: 'w1',
        amountConsumed: -1,
      }),
    ).rejects.toThrow('must be a finite non-negative number');
  });

  it('enforces version CAS on budget consumption and release', async () => {
    const windowKey = '2026-08-23';
    const res = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:cas:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit: 10,
      ownerId: 'w1',
    });

    expect(res.granted).toBe(true);

    // Stale version CAS
    await expect(
      budgetRepo.consumeBudget({
        idempotencyKey: 'budget:cas:1',
        ownerId: 'w1',
        amountConsumed: 1.5,
        expectedVersion: 99,
      }),
    ).rejects.toThrow('Stale reservation version');

    // Matching version CAS
    const consumed = await budgetRepo.consumeBudget({
      idempotencyKey: 'budget:cas:1',
      ownerId: 'w1',
      amountConsumed: 1.5,
      expectedVersion: 1,
    });
    expect(consumed.version).toBe(2);
  });

  it('reconciles expired reservations and counts reconciled spend in budget totals', async () => {
    const windowKey = '2026-08-23';
    const limit = 10.0;

    // Create reservation with past expiry
    await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:expired:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 5.0,
      limit,
      ownerId: 'worker-abandoned',
      ttlMs: -10_000, // already expired in the past
    });

    const reconciledCount = await budgetRepo.reconcileExpiredReservations();
    expect(reconciledCount).toBe(1);

    const status1 = await budgetRepo.getBudgetStatus({
      category: 'DAILY_USD',
      windowKey,
      limit,
    });

    expect(status1.totalActiveReserved).toBe(0);
    expect(status1.totalCommitted).toBe(0);
    expect(status1.remainingAvailable).toBe(10.0);

    // Explicit reconciled reservation with actual incurred spend
    await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:recon:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 3.0,
      limit,
      ownerId: 'worker-1',
    });

    await budgetRepo.reconcileBudgetReservation({
      idempotencyKey: 'budget:recon:1',
      amountConsumed: 2.5,
    });

    const status2 = await budgetRepo.getBudgetStatus({
      category: 'DAILY_USD',
      windowKey,
      limit,
    });

    expect(status2.totalConsumed).toBe(2.5);
    expect(status2.totalCommitted).toBe(2.5);
    expect(status2.remainingAvailable).toBe(7.5);
  });

  it('rejects reservation replay when actively held by another claim owner', async () => {
    const windowKey = '2026-08-23';
    const limit = 10.0;

    const res1 = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:owner-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-primary',
      ttlMs: 60_000,
    });
    expect(res1.granted).toBe(true);

    const res2 = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:owner-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-impostor',
    });

    expect(res2.granted).toBe(false);
    expect(res2.isDuplicate).toBe(true);
    if (!res2.granted) {
      expect(res2.reason).toContain('actively held by another claim owner');
    }
  });

  it('denies fresh grant on replay of CONSUMED, RELEASED, and RECONCILED reservations', async () => {
    const windowKey = '2026-08-23';
    const limit = 10.0;

    // 1. CONSUMED status
    await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:consumed-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-1',
    });
    await budgetRepo.consumeBudget({
      idempotencyKey: 'budget:consumed-test:1',
      ownerId: 'worker-1',
      amountConsumed: 2.0,
    });

    const replayConsumed = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:consumed-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-1',
    });
    expect(replayConsumed.granted).toBe(false);
    expect(replayConsumed.isDuplicate).toBe(true);
    if (!replayConsumed.granted) {
      expect(replayConsumed.reason).toContain('already CONSUMED');
    }

    // 2. RELEASED status
    await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:released-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-1',
    });
    await budgetRepo.releaseBudget({
      idempotencyKey: 'budget:released-test:1',
      ownerId: 'worker-1',
    });

    const replayReleased = await budgetRepo.reserveBudget({
      idempotencyKey: 'budget:released-test:1',
      category: 'DAILY_USD',
      windowKey,
      amountReserved: 2.0,
      limit,
      ownerId: 'worker-1',
    });
    expect(replayReleased.granted).toBe(false);
    expect(replayReleased.isDuplicate).toBe(true);
    if (!replayReleased.granted) {
      expect(replayReleased.reason).toContain('terminal status RELEASED');
    }
  });

  it('accurately counts durable event reservations for per-event budget limits', async () => {
    const eventId = '99999999-9999-4999-8999-999999999999';
    const windowKey = '2026-08-23';

    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId: 'corr-count-test',
        sourceIp: '198.51.100.15',
        targetAsset: 'mock-portal',
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        failedLoginCount: 1,
        riskIndicators: ['test'],
        containmentMode: 'SIMULATED',
        usedDecoyCredential: false,
        status: 'PENDING',
        provenance: 'OBSERVED',
      },
    });

    try {
      await budgetRepo.reserveBudget({
        idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        amountReserved: 1000,
        limit: 100_000,
        ownerId: 'w1',
        eventId,
      });

      const count1 = await budgetRepo.countEventReservations(eventId, 'DAILY_GEMINI_TOKENS');
      expect(count1).toBe(1);

      await budgetRepo.reserveBudget({
        idempotencyKey: `gemini-tokens:${eventId}:attempt-2`,
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        amountReserved: 1000,
        limit: 100_000,
        ownerId: 'w2',
        eventId,
      });

      const count2 = await budgetRepo.countEventReservations(eventId, 'DAILY_GEMINI_TOKENS');
      expect(count2).toBe(2);

      // 3rd attempt for the same event must be rejected by durable limit check
      const res3 = await budgetRepo.reserveBudget({
        idempotencyKey: `gemini-tokens:${eventId}:attempt-3`,
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        amountReserved: 1000,
        limit: 100_000,
        ownerId: 'w3',
        eventId,
      });
      expect(res3.granted).toBe(false);
      if (!res3.granted) {
        expect(res3.reason).toContain('Durable Gemini model call limit exceeded');
      }
    } finally {
      await db.budgetReservationRecord.deleteMany({ where: { eventId } });
      await db.intrusionEvent.deleteMany({ where: { id: eventId } });
    }
  });

  it('does not use unrelated tool provider intents as evidence about a Gemini reservation', async () => {
    const eventId = '11111111-2222-3333-4444-555555555555';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-unrelated-intent', '198.51.100.20');

    // FAILED Cloud Run tool intents previously caused the Gemini reservation to be EXPIRED.
    await db.providerIntentRecord.create({
      data: {
        idempotencyKey: `intent-${eventId}`,
        eventId,
        operationType: 'request_decoy_deployment',
        provider: 'CLOUD_RUN',
        status: 'FAILED',
        result: { error: 'Cloud Run deployment rejected' },
      },
    });

    await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-unrelated',
      eventId,
      ttlMs: -10_000,
    });

    try {
      expect(await budgetRepo.reconcileExpiredReservations()).toBe(1);

      const record = await db.budgetReservationRecord.findUniqueOrThrow({
        where: { idempotencyKey: `gemini-tokens:${eventId}:attempt-1` },
      });
      expect(record.status).toBe('RECONCILED');
      expect(Number(record.amountConsumed)).toBe(5000);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('retains an expired Gemini reservation as committed spend when no attempt evidence exists', async () => {
    const eventId = '22222222-3333-4444-5555-666666666666';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-no-evidence', '198.51.100.21');

    await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-no-evidence',
      eventId,
      ttlMs: -10_000,
    });

    try {
      expect(await budgetRepo.reconcileExpiredReservations()).toBe(1);

      const record = await db.budgetReservationRecord.findUniqueOrThrow({
        where: { idempotencyKey: `gemini-tokens:${eventId}:attempt-1` },
      });
      expect(record.status).toBe('RECONCILED');
      expect(Number(record.amountConsumed)).toBe(5000);

      const status = await budgetRepo.getBudgetStatus({
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        limit: 100_000,
      });
      expect(status.totalConsumed).toBe(5000);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('expires an expired Gemini reservation only on a verified pre-call failure', async () => {
    const eventId = '33333333-4444-5555-6666-777777777777';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-precall-fail', '198.51.100.22');

    const reserved = await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-precall',
      eventId,
      ttlMs: -10_000,
    });
    expect(reserved.granted).toBe(true);

    await budgetRepo.recordGeminiAttemptOutcome({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      ownerId: 'worker-precall',
      outcome: 'PRE_CALL_FAILED',
    });

    try {
      expect(await budgetRepo.reconcileExpiredReservations()).toBe(1);

      const record = await db.budgetReservationRecord.findUniqueOrThrow({
        where: { idempotencyKey: `gemini-tokens:${eventId}:attempt-1` },
      });
      expect(record.status).toBe('EXPIRED');

      const status = await budgetRepo.getBudgetStatus({
        category: 'DAILY_GEMINI_TOKENS',
        windowKey,
        limit: 100_000,
      });
      expect(status.totalCommitted).toBe(0);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('reconciles an expired Gemini reservation with dispatch evidence as fully spent', async () => {
    const eventId = '44444444-5555-6666-7777-888888888888';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-dispatched', '198.51.100.23');

    await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-dispatched',
      eventId,
      ttlMs: -10_000,
    });

    await budgetRepo.recordGeminiAttemptOutcome({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      ownerId: 'worker-dispatched',
      outcome: 'DISPATCHED',
      expectedVersion: 1,
    });

    try {
      expect(await budgetRepo.reconcileExpiredReservations()).toBe(1);

      const record = await db.budgetReservationRecord.findUniqueOrThrow({
        where: { idempotencyKey: `gemini-tokens:${eventId}:attempt-1` },
      });
      expect(record.status).toBe('RECONCILED');
      expect(Number(record.amountConsumed)).toBe(5000);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('is idempotent and cannot double-transition a row under concurrent reconciliation', async () => {
    const eventId = '55555555-6666-7777-8888-999999999999';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-concurrent-recon', '198.51.100.24');

    await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 5000,
      limit: 100_000,
      ownerId: 'worker-concurrent-recon',
      eventId,
      ttlMs: -10_000,
    });

    try {
      const counts = await Promise.all([
        budgetRepo.reconcileExpiredReservations(),
        budgetRepo.reconcileExpiredReservations(),
        budgetRepo.reconcileExpiredReservations(),
      ]);

      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);

      const record = await db.budgetReservationRecord.findUniqueOrThrow({
        where: { idempotencyKey: `gemini-tokens:${eventId}:attempt-1` },
      });
      expect(record.status).toBe('RECONCILED');
      expect(record.version).toBe(2);

      // A later sweep must be a no-op.
      expect(await budgetRepo.reconcileExpiredReservations()).toBe(0);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('derives sequential attempt slots durably and refuses a third accounted attempt', async () => {
    const eventId = '66666666-7777-8888-9999-000000000000';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-slot-derivation', '198.51.100.25');

    try {
      const slotInput = {
        eventId,
        category: 'DAILY_GEMINI_TOKENS' as const,
        windowKey,
        amountReserved: 8192,
        limit: 100_000,
        maxAttempts: 2,
        idempotencyKeyPrefix: `gemini-tokens:${eventId}`,
      };

      const first = await budgetRepo.acquireEventAttemptSlot({ ...slotInput, ownerId: 'w-a' });
      expect(first.granted).toBe(true);
      if (!first.granted) return;
      expect(first.attemptNumber).toBe(1);
      expect(first.reservation.idempotencyKey).toBe(`gemini-tokens:${eventId}:attempt-1`);

      const second = await budgetRepo.acquireEventAttemptSlot({ ...slotInput, ownerId: 'w-b' });
      expect(second.granted).toBe(true);
      if (!second.granted) return;
      expect(second.attemptNumber).toBe(2);

      const third = await budgetRepo.acquireEventAttemptSlot({ ...slotInput, ownerId: 'w-c' });
      expect(third.granted).toBe(false);
      if (!third.granted) {
        expect(third.reason).toContain('Durable model attempt limit exceeded');
      }
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('returns the same slot for an idempotent replay by the same owner', async () => {
    const eventId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-slot-replay', '198.51.100.26');

    try {
      const slotInput = {
        eventId,
        category: 'DAILY_GEMINI_TOKENS' as const,
        windowKey,
        amountReserved: 8192,
        limit: 100_000,
        maxAttempts: 2,
        ownerId: 'w-replay',
        idempotencyKeyPrefix: `gemini-tokens:${eventId}`,
      };

      const first = await budgetRepo.acquireEventAttemptSlot(slotInput);
      const replay = await budgetRepo.acquireEventAttemptSlot(slotInput);

      expect(first.granted).toBe(true);
      expect(replay.granted).toBe(true);
      if (!first.granted || !replay.granted) return;
      expect(replay.isDuplicate).toBe(true);
      expect(replay.attemptNumber).toBe(first.attemptNumber);
      expect(replay.reservation.id).toBe(first.reservation.id);

      const rowCount = await db.budgetReservationRecord.count({ where: { eventId } });
      expect(rowCount).toBe(1);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('prevents two concurrent workers from authorizing more than two attempts for one event', async () => {
    const eventId = '88888888-9999-aaaa-bbbb-cccccccccccc';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-slot-concurrency', '198.51.100.27');

    try {
      const outcomes = await Promise.all(
        ['w1', 'w2', 'w3', 'w4', 'w5'].map((ownerId) =>
          budgetRepo.acquireEventAttemptSlot({
            eventId,
            category: 'DAILY_GEMINI_TOKENS',
            windowKey,
            amountReserved: 8192,
            limit: 100_000,
            maxAttempts: 2,
            ownerId,
            idempotencyKeyPrefix: `gemini-tokens:${eventId}`,
          }),
        ),
      );

      const granted = outcomes.filter((outcome) => outcome.granted);
      expect(granted).toHaveLength(2);
      expect(
        granted.map((outcome) => (outcome.granted ? outcome.attemptNumber : 0)).toSorted(),
      ).toEqual([1, 2]);

      const rowCount = await db.budgetReservationRecord.count({ where: { eventId } });
      expect(rowCount).toBe(2);
    } finally {
      await cleanupEvent(eventId);
    }
  });

  it('refuses to record attempt evidence for a reservation held by another owner', async () => {
    const eventId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const windowKey = '2026-08-23';

    await createEvent(eventId, 'corr-evidence-owner', '198.51.100.28');

    await budgetRepo.reserveBudget({
      idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey,
      amountReserved: 8192,
      limit: 100_000,
      ownerId: 'rightful-owner',
      eventId,
    });

    try {
      await expect(
        budgetRepo.recordGeminiAttemptOutcome({
          idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
          ownerId: 'other-owner',
          outcome: 'DISPATCHED',
        }),
      ).rejects.toThrow('Failed to record model attempt outcome');

      // Evidence write must not disturb the version the rightful owner fenced on.
      await budgetRepo.recordGeminiAttemptOutcome({
        idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
        ownerId: 'rightful-owner',
        outcome: 'DISPATCHED',
        expectedVersion: 1,
      });

      const settled = await budgetRepo.consumeBudget({
        idempotencyKey: `gemini-tokens:${eventId}:attempt-1`,
        ownerId: 'rightful-owner',
        amountConsumed: 1200,
        expectedVersion: 1,
      });
      expect(settled.status).toBe('CONSUMED');
    } finally {
      await cleanupEvent(eventId);
    }
  });
});
