import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiBudgetService, type GeminiAttemptGate } from './gemini-budget-service.js';
import { type BudgetRepository } from '@false-route/database';

interface FakeSlot {
  attemptNumber: number;
  idempotencyKey: string;
  ownerId: string;
  status: 'RESERVED' | 'CONSUMED' | 'RELEASED';
}

describe('GeminiBudgetService', () => {
  let mockBudgetRepo: BudgetRepository;
  let service: GeminiBudgetService;
  let slots: FakeSlot[];

  /** Mimics the repository's durable slot allocation: max 2 accounted attempts per event. */
  function buildFakeRepo(maxAttempts = 2): BudgetRepository {
    slots = [];
    return {
      acquireEventAttemptSlot: vi.fn().mockImplementation(async (params) => {
        const accounted = slots.filter((s) => s.status !== 'RELEASED').length;
        if (accounted >= maxAttempts) {
          return {
            granted: false,
            isDuplicate: false,
            reason: `Durable model attempt limit exceeded: event ${params.eventId} already has ${accounted} of ${maxAttempts} accounted DAILY_GEMINI_TOKENS attempts`,
            currentCommitted: params.limit,
            limit: params.limit,
          };
        }
        const attemptNumber = slots.length + 1;
        const slot: FakeSlot = {
          attemptNumber,
          idempotencyKey: `${params.idempotencyKeyPrefix}:attempt-${attemptNumber}`,
          ownerId: params.ownerId,
          status: 'RESERVED',
        };
        slots.push(slot);
        return {
          granted: true,
          isDuplicate: false,
          attemptNumber,
          reservation: {
            id: `res-${attemptNumber}`,
            idempotencyKey: slot.idempotencyKey,
            category: 'DAILY_GEMINI_TOKENS',
            windowKey: params.windowKey,
            amountReserved: params.amountReserved,
            amountConsumed: null,
            status: 'RESERVED',
            ownerId: params.ownerId,
            expiresAt: new Date(Date.now() + 60_000),
            eventId: params.eventId,
            version: 1,
          },
        };
      }),
      recordGeminiAttemptOutcome: vi.fn().mockResolvedValue(undefined),
      consumeBudget: vi.fn().mockImplementation(async (params) => {
        const slot = slots.find((s) => s.idempotencyKey === params.idempotencyKey);
        if (slot) slot.status = 'CONSUMED';
        return {};
      }),
      releaseBudget: vi.fn().mockImplementation(async (params) => {
        const slot = slots.find((s) => s.idempotencyKey === params.idempotencyKey);
        if (slot) slot.status = 'RELEASED';
        return {};
      }),
    } as unknown as BudgetRepository;
  }

  beforeEach(() => {
    mockBudgetRepo = buildFakeRepo();
    service = new GeminiBudgetService({
      budgetRepo: mockBudgetRepo,
      maxInputTokensPerEvent: 8192,
      dailyTokenLimit: 100_000,
      maxCallsPerEvent: 2,
      clock: () => new Date('2026-08-23T10:00:00.000Z'),
    });
  });

  it('consumes exactly one durable reservation when the first attempt succeeds', async () => {
    interface TestModelResponse {
      text: string;
      usage: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    }

    const executeFn = vi.fn().mockImplementation(async (gate: GeminiAttemptGate) => {
      await gate.beginAttempt();
      return {
        text: 'Analysis output',
        usage: { promptTokenCount: 1500, candidatesTokenCount: 300, totalTokenCount: 1800 },
      };
    });

    const result = await service.executeWithBudget<TestModelResponse>({
      eventId: 'event-1',
      execute: executeFn,
      extractUsageMetadata: (res) => res.usage,
    });

    expect(result.text).toBe('Analysis output');
    expect(mockBudgetRepo.acquireEventAttemptSlot).toHaveBeenCalledTimes(1);
    expect(mockBudgetRepo.acquireEventAttemptSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'DAILY_GEMINI_TOKENS',
        windowKey: '2026-08-23',
        amountReserved: 8192,
        limit: 100_000,
        maxAttempts: 2,
        eventId: 'event-1',
        idempotencyKeyPrefix: 'gemini-tokens:event-1',
      }),
    );
    expect(mockBudgetRepo.consumeBudget).toHaveBeenCalledTimes(1);
    expect(mockBudgetRepo.consumeBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-1:attempt-1',
        amountConsumed: 1800,
        expectedVersion: 1,
      }),
    );
  });

  it('derives the attempt slot durably and never from a caller-supplied attempt number', async () => {
    const executeFn = vi.fn().mockResolvedValue({ text: 'ok' });

    await service.executeWithBudget({ eventId: 'event-1', attemptNumber: 2, execute: executeFn });

    expect(mockBudgetRepo.consumeBudget).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'gemini-tokens:event-1:attempt-1' }),
    );
  });

  it('writes the DISPATCHED marker before the provider is invoked', async () => {
    const callOrder: string[] = [];
    vi.mocked(mockBudgetRepo.recordGeminiAttemptOutcome).mockImplementation(async () => {
      callOrder.push('mark');
    });

    await service.executeWithBudget({
      eventId: 'event-1',
      execute: async () => {
        callOrder.push('provider');
        return { text: 'ok' };
      },
    });

    expect(callOrder).toEqual(['mark', 'provider']);
    expect(mockBudgetRepo.recordGeminiAttemptOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-1:attempt-1',
        outcome: 'DISPATCHED',
        expectedVersion: 1,
      }),
    );
  });

  it('charges a retried attempt against its own durable reservation', async () => {
    const executeFn = vi.fn().mockImplementation(async (gate: GeminiAttemptGate) => {
      const first = await gate.beginAttempt();
      expect(first.attemptNumber).toBe(1);
      const second = await gate.beginAttempt();
      expect(second.attemptNumber).toBe(2);
      return { text: 'succeeded on retry' };
    });

    const result = await service.executeWithBudget<{ text: string }>({
      eventId: 'event-retry',
      execute: executeFn,
    });

    expect(result.text).toBe('succeeded on retry');
    expect(mockBudgetRepo.acquireEventAttemptSlot).toHaveBeenCalledTimes(2);

    // Attempt 1 failed ambiguously and is charged in full; attempt 2 settles normally.
    expect(mockBudgetRepo.consumeBudget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-retry:attempt-1',
        amountConsumed: 8192,
      }),
    );
    expect(mockBudgetRepo.consumeBudget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'gemini-tokens:event-retry:attempt-2' }),
    );
    expect(mockBudgetRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it('rejects a third provider attempt durably before the provider is invoked', async () => {
    const providerSpy = vi.fn().mockResolvedValue({ text: 'must not happen' });

    const executeFn = vi.fn().mockImplementation(async (gate: GeminiAttemptGate) => {
      await gate.beginAttempt();
      await gate.beginAttempt();
      await gate.beginAttempt();
      return providerSpy();
    });

    await expect(
      service.executeWithBudget({ eventId: 'event-third', execute: executeFn }),
    ).rejects.toThrow('Gemini durable token budget ceiling exceeded');

    expect(providerSpy).not.toHaveBeenCalled();
    expect(mockBudgetRepo.acquireEventAttemptSlot).toHaveBeenCalledTimes(3);
  });

  it('charges the full maximum reservation when usage metadata is missing or invalid', async () => {
    const executeFn = vi.fn().mockResolvedValue({ text: 'no usage metadata' });

    await service.executeWithBudget({ eventId: 'event-1', execute: executeFn });

    expect(mockBudgetRepo.consumeBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-1:attempt-1',
        amountConsumed: 8192,
      }),
    );
  });

  it('records verified non-dispatch and releases only on a verified pre-call error', async () => {
    const preCallError = new Error('Invalid prompt schema before dispatch');
    const executeFn = vi.fn().mockRejectedValue(preCallError);

    await expect(
      service.executeWithBudget({
        eventId: 'event-1',
        execute: executeFn,
        isPreCallError: (err) => err === preCallError,
      }),
    ).rejects.toThrow('Invalid prompt schema before dispatch');

    expect(mockBudgetRepo.recordGeminiAttemptOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-1:attempt-1',
        outcome: 'PRE_CALL_FAILED',
      }),
    );
    expect(mockBudgetRepo.releaseBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-1:attempt-1',
        expectedVersion: 1,
      }),
    );
  });

  it('keeps the reservation committed when verified non-dispatch evidence cannot be persisted', async () => {
    const preCallError = new Error('Invalid prompt schema before dispatch');
    const evidenceError = new Error('DB write failure recording PRE_CALL_FAILED evidence');
    vi.mocked(mockBudgetRepo.recordGeminiAttemptOutcome)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(evidenceError);

    await expect(
      service.executeWithBudget({
        eventId: 'event-evidence-failure',
        execute: vi.fn().mockRejectedValue(preCallError),
        isPreCallError: (err) => err === preCallError,
      }),
    ).rejects.toThrow(evidenceError);

    expect(mockBudgetRepo.recordGeminiAttemptOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gemini-tokens:event-evidence-failure:attempt-1',
        outcome: 'PRE_CALL_FAILED',
        expectedVersion: 1,
      }),
    );
    expect(mockBudgetRepo.releaseBudget).not.toHaveBeenCalled();
    expect(slots[0]?.status).toBe('RESERVED');
  });

  it('keeps reservation committed and does not release on ambiguous provider timeout', async () => {
    const providerTimeoutError = new Error('HTTP 504 Gateway Timeout');
    const executeFn = vi.fn().mockRejectedValue(providerTimeoutError);

    await expect(
      service.executeWithBudget({
        eventId: 'event-1',
        execute: executeFn,
        isPreCallError: () => false,
      }),
    ).rejects.toThrow('HTTP 504 Gateway Timeout');

    expect(mockBudgetRepo.releaseBudget).not.toHaveBeenCalled();
    expect(mockBudgetRepo.consumeBudget).not.toHaveBeenCalled();
  });

  it('fails closed when the durable ceiling is exceeded before any provider call', async () => {
    vi.mocked(mockBudgetRepo.acquireEventAttemptSlot).mockResolvedValueOnce({
      granted: false,
      isDuplicate: false,
      reason: 'Durable budget ceiling exceeded for category DAILY_GEMINI_TOKENS',
      currentCommitted: 95_000,
      limit: 100_000,
    });

    const executeFn = vi.fn();

    await expect(
      service.executeWithBudget({ eventId: 'event-1', execute: executeFn }),
    ).rejects.toThrow('Gemini durable token budget ceiling exceeded');

    expect(executeFn).not.toHaveBeenCalled();
  });

  it('does not dispatch when the DISPATCHED marker cannot be persisted', async () => {
    vi.mocked(mockBudgetRepo.recordGeminiAttemptOutcome).mockRejectedValueOnce(
      new Error('DB write failure recording attempt evidence'),
    );

    const executeFn = vi.fn();

    await expect(
      service.executeWithBudget({ eventId: 'event-1', execute: executeFn }),
    ).rejects.toThrow('DB write failure recording attempt evidence');

    expect(executeFn).not.toHaveBeenCalled();
    expect(mockBudgetRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it.each([
    [0, '0'],
    [-1, '-1'],
    [1.5, '1.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [3, '3'],
  ])(
    'rejects invalid attemptNumber $1 before any provider invocation',
    async (attemptNumber, rendered) => {
      const executeFn = vi.fn();

      await expect(
        service.executeWithBudget({ eventId: 'event-1', attemptNumber, execute: executeFn }),
      ).rejects.toThrow(
        `Invalid Gemini attemptNumber: ${rendered} must be an integer between 1 and 2`,
      );

      expect(mockBudgetRepo.acquireEventAttemptSlot).not.toHaveBeenCalled();
      expect(mockBudgetRepo.recordGeminiAttemptOutcome).not.toHaveBeenCalled();
      expect(executeFn).not.toHaveBeenCalled();
    },
  );

  it('does not release incurred spend when the settlement write fails', async () => {
    vi.mocked(mockBudgetRepo.consumeBudget).mockRejectedValueOnce(
      new Error('DB write failure during consumeBudget'),
    );

    const executeFn = vi.fn().mockResolvedValue({ text: 'Provider succeeded' });

    const result = await service.executeWithBudget<{ text: string }>({
      eventId: 'event-settle-fail',
      execute: executeFn,
    });

    expect(result.text).toBe('Provider succeeded');
    expect(mockBudgetRepo.releaseBudget).not.toHaveBeenCalled();
  });
});
