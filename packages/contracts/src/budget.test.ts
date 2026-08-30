import { describe, it, expect } from 'vitest';
import {
  BudgetCategorySchema,
  BudgetReservationStatusSchema,
  BudgetReservationSchema,
  BudgetStatusSchema,
  GeminiAttemptOutcomeSchema,
  BUDGET_LIMITS,
} from './budget.js';

describe('Budget Contracts', () => {
  it('validates budget categories accurately', () => {
    expect(BudgetCategorySchema.parse('DAILY_USD')).toBe('DAILY_USD');
    expect(BudgetCategorySchema.parse('DAILY_GEMINI_TOKENS')).toBe('DAILY_GEMINI_TOKENS');
    expect(BudgetCategorySchema.parse('HOURLY_TOOL_OPERATIONS')).toBe('HOURLY_TOOL_OPERATIONS');
    expect(() => BudgetCategorySchema.parse('INVALID_CATEGORY')).toThrow();
  });

  it('validates budget reservation statuses accurately', () => {
    expect(BudgetReservationStatusSchema.parse('RESERVED')).toBe('RESERVED');
    expect(BudgetReservationStatusSchema.parse('CONSUMED')).toBe('CONSUMED');
    expect(BudgetReservationStatusSchema.parse('RELEASED')).toBe('RELEASED');
    expect(BudgetReservationStatusSchema.parse('EXPIRED')).toBe('EXPIRED');
    expect(BudgetReservationStatusSchema.parse('RECONCILED')).toBe('RECONCILED');
    expect(() => BudgetReservationStatusSchema.parse('PENDING')).toThrow();
  });

  it('validates Gemini attempt outcome evidence values', () => {
    expect(GeminiAttemptOutcomeSchema.parse('DISPATCHED')).toBe('DISPATCHED');
    expect(GeminiAttemptOutcomeSchema.parse('PRE_CALL_FAILED')).toBe('PRE_CALL_FAILED');
    expect(() => GeminiAttemptOutcomeSchema.parse('EXECUTED')).toThrow();
    expect(() => GeminiAttemptOutcomeSchema.parse('')).toThrow();
  });

  it('accepts an optional attempt outcome on a reservation and rejects an invalid one', () => {
    const base = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      idempotencyKey: 'gemini-tokens:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11:attempt-1',
      category: 'DAILY_GEMINI_TOKENS' as const,
      windowKey: '2026-08-23',
      amountReserved: 8192,
      status: 'RESERVED' as const,
      ownerId: 'worker-1',
      expiresAt: '2026-08-23T10:01:00.000Z',
      version: 1,
      createdAt: '2026-08-23T10:00:00.000Z',
    };

    expect(
      BudgetReservationSchema.parse({ ...base, geminiAttemptOutcome: 'DISPATCHED' })
        .geminiAttemptOutcome,
    ).toBe('DISPATCHED');
    expect(BudgetReservationSchema.parse(base).geminiAttemptOutcome).toBeUndefined();
    expect(() =>
      BudgetReservationSchema.parse({ ...base, geminiAttemptOutcome: 'MAYBE' }),
    ).toThrow();
  });

  it('validates BudgetReservationSchema with full valid record', () => {
    const valid = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      idempotencyKey: 'budget:daily-usd:event-123',
      category: 'DAILY_USD',
      windowKey: '2026-08-23',
      amountReserved: 1.5,
      amountConsumed: 1.25,
      status: 'CONSUMED',
      ownerId: 'worker-autonomous-01',
      expiresAt: '2026-08-23T10:00:00.000Z',
      consumedAt: '2026-08-23T09:35:00.000Z',
      eventId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      version: 1,
      createdAt: '2026-08-23T09:30:00.000Z',
    };
    const parsed = BudgetReservationSchema.parse(valid);
    expect(parsed.idempotencyKey).toBe('budget:daily-usd:event-123');
    expect(parsed.amountReserved).toBe(1.5);
  });

  it('rejects BudgetReservationSchema with invalid fields or negative amounts', () => {
    const invalid = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      idempotencyKey: 'budget:daily-usd:event-123',
      category: 'DAILY_USD',
      windowKey: '2026-08-23',
      amountReserved: -5,
      status: 'RESERVED',
      ownerId: 'worker-autonomous-01',
      expiresAt: '2026-08-23T10:00:00.000Z',
      version: 1,
      createdAt: '2026-08-23T09:30:00.000Z',
    };
    expect(() => BudgetReservationSchema.parse(invalid)).toThrow();
  });

  it('validates BudgetStatusSchema', () => {
    const valid = {
      category: 'DAILY_USD',
      windowKey: '2026-08-23',
      limit: 10.0,
      totalConsumed: 3.5,
      totalActiveReserved: 1.0,
      totalCommitted: 4.5,
      remainingAvailable: 5.5,
      isExceeded: false,
    };
    const parsed = BudgetStatusSchema.parse(valid);
    expect(parsed.remainingAvailable).toBe(5.5);
    expect(parsed.isExceeded).toBe(false);
  });

  it('declares frozen system budget limit constants matching ADR-0005', () => {
    expect(BUDGET_LIMITS.DAILY_USD).toBe(10.0);
    expect(BUDGET_LIMITS.DAILY_GEMINI_TOKENS).toBe(1_000_000);
    expect(BUDGET_LIMITS.HOURLY_TOOL_OPERATIONS).toBe(50);
    expect(BUDGET_LIMITS.MAX_GEMINI_INPUT_TOKENS_PER_EVENT).toBe(8192);
    expect(BUDGET_LIMITS.MAX_GEMINI_OUTPUT_TOKENS_PER_CALL).toBe(2048);
    expect(BUDGET_LIMITS.MAX_GEMINI_CALLS_PER_EVENT).toBe(2);
    expect(BUDGET_LIMITS.MAX_ACTIVE_DECOYS).toBe(3);
    expect(BUDGET_LIMITS.MAX_ACTIVE_QUARANTINE_RULES).toBe(10);
  });
});
