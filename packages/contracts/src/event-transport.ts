import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './primitives.js';

export const PubSubMessageDataSchema = z
  .object({
    data: z.string().min(1),
    messageId: z.string().min(1).max(128),
    publishTime: IsoDateTimeSchema,
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type PubSubMessageData = z.infer<typeof PubSubMessageDataSchema>;

export const PubSubPushEnvelopeSchema = z
  .object({
    message: PubSubMessageDataSchema,
    subscription: z.string().min(1).max(256),
    deliveryAttempt: z.number().int().min(1).optional(),
  })
  .strict();

export type PubSubPushEnvelope = z.infer<typeof PubSubPushEnvelopeSchema>;

export const DeadLetterInspectionRecordSchema = z
  .object({
    deadLetterId: UuidSchema,
    originalMessageId: z.string().min(1).max(128),
    originalEventId: UuidSchema.nullable(),
    failedAt: IsoDateTimeSchema,
    failureReason: z.string().min(1).max(512),
    retryCount: z.number().int().min(0),
    payload: z.record(z.string(), z.unknown()),
    replayStatus: z.enum(['AVAILABLE', 'REPLAYING', 'REPLAYED', 'REVIEW_REQUIRED', 'DISCARDED']),
  })
  .strict();

export type DeadLetterInspectionRecord = z.infer<typeof DeadLetterInspectionRecordSchema>;

export const ReplayDeadLetterRequestSchema = z
  .object({
    deadLetterId: UuidSchema,
    rationale: z.string().min(5).max(512),
  })
  .strict();

export type ReplayDeadLetterRequest = z.infer<typeof ReplayDeadLetterRequestSchema>;

export const ReplayDeadLetterResponseSchema = z
  .object({
    replayId: UuidSchema,
    originalEventId: UuidSchema,
    newTransportId: z.string().min(1).max(128),
    replayedAt: IsoDateTimeSchema,
    status: z.literal('ACCEPTED'),
  })
  .strict();

export type ReplayDeadLetterResponse = z.infer<typeof ReplayDeadLetterResponseSchema>;
