import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './primitives.js';

export const BudgetCategorySchema = z.enum([
  'DAILY_USD',
  'DAILY_GEMINI_TOKENS',
  'HOURLY_TOOL_OPERATIONS',
]);

export type BudgetCategory = z.infer<typeof BudgetCategorySchema>;

export const BudgetReservationStatusSchema = z.enum([
  'RESERVED',
  'CONSUMED',
  'RELEASED',
  'EXPIRED',
  'RECONCILED',
]);

export type BudgetReservationStatus = z.infer<typeof BudgetReservationStatusSchema>;

/**
 * Evidence recorded against a single Gemini attempt reservation. `DISPATCHED` is written
 * immediately before the provider request leaves the process; `PRE_CALL_FAILED` only when
 * non-dispatch was verified. An absent value is not evidence that no call was made.
 */
export const GeminiAttemptOutcomeSchema = z.enum(['DISPATCHED', 'PRE_CALL_FAILED']);

export type GeminiAttemptOutcome = z.infer<typeof GeminiAttemptOutcomeSchema>;

export const BUDGET_LIMITS = {
  DAILY_USD: 10.0,
  DAILY_GEMINI_TOKENS: 1_000_000,
  HOURLY_TOOL_OPERATIONS: 50,
  MAX_GEMINI_INPUT_TOKENS_PER_EVENT: 8192,
  MAX_GEMINI_OUTPUT_TOKENS_PER_CALL: 2048,
  MAX_GEMINI_CALLS_PER_EVENT: 2,
  MAX_ACTIVE_DECOYS: 3,
  MAX_ACTIVE_QUARANTINE_RULES: 10,
} as const;

export const GeminiUsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().int().min(0),
    candidatesTokenCount: z.number().int().min(0).optional(),
    totalTokenCount: z.number().int().min(0).optional(),
  })
  .strict();

export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>;

export const BudgetReservationSchema = z
  .object({
    id: UuidSchema,
    idempotencyKey: z.string().min(1).max(128),
    category: BudgetCategorySchema,
    windowKey: z.string().min(1).max(64),
    amountReserved: z.number().positive(),
    amountConsumed: z.number().min(0).optional(),
    status: BudgetReservationStatusSchema,
    ownerId: z.string().min(1).max(128),
    expiresAt: IsoDateTimeSchema,
    consumedAt: IsoDateTimeSchema.optional(),
    releasedAt: IsoDateTimeSchema.optional(),
    reconciledAt: IsoDateTimeSchema.optional(),
    eventId: UuidSchema.optional(),
    geminiAttemptOutcome: GeminiAttemptOutcomeSchema.optional(),
    version: z.number().int().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const BudgetStatusSchema = z
  .object({
    category: BudgetCategorySchema,
    windowKey: z.string().min(1).max(64),
    limit: z.number().positive(),
    totalConsumed: z.number().min(0),
    totalActiveReserved: z.number().min(0),
    totalCommitted: z.number().min(0),
    remainingAvailable: z.number().min(0),
    isExceeded: z.boolean(),
  })
  .strict();

export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;
