import { z } from 'zod';
import { UuidSchema, CorrelationIdSchema, IsoDateTimeSchema } from './primitives.js';
import {
  SimulatedIntrusionEventInputSchema,
  IntrusionEventSchema,
  ProcessingStatusSchema,
} from './intrusion-event.js';
import { DeceptionDecisionSchema } from './deception-decision.js';

export const CreateIntrusionEventRequestSchema = SimulatedIntrusionEventInputSchema;
export type CreateIntrusionEventRequest = z.infer<typeof CreateIntrusionEventRequestSchema>;

export const CreateIntrusionEventResponseSchema = z
  .object({
    id: UuidSchema,
    correlationId: CorrelationIdSchema,
    status: z.literal('PENDING'),
    message: z.string().min(1).max(200),
    receivedAt: IsoDateTimeSchema,
  })
  .strict();

export type CreateIntrusionEventResponse = z.infer<typeof CreateIntrusionEventResponseSchema>;

export const ListIntrusionEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: ProcessingStatusSchema.optional(),
  })
  .strict();

export type ListIntrusionEventsQuery = z.infer<typeof ListIntrusionEventsQuerySchema>;

export const ListIntrusionEventsResponseSchema = z
  .object({
    events: z.array(IntrusionEventSchema),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  })
  .strict();

export type ListIntrusionEventsResponse = z.infer<typeof ListIntrusionEventsResponseSchema>;

export const GetIntrusionEventResponseSchema = z
  .object({
    event: IntrusionEventSchema,
    decision: DeceptionDecisionSchema.nullable().optional(),
  })
  .strict();

export type GetIntrusionEventResponse = z.infer<typeof GetIntrusionEventResponseSchema>;

export const GetDeceptionDecisionResponseSchema = z
  .object({
    decision: DeceptionDecisionSchema,
  })
  .strict();

export type GetDeceptionDecisionResponse = z.infer<typeof GetDeceptionDecisionResponseSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
    correlationId: CorrelationIdSchema.optional(),
    details: z.array(z.string().min(1).max(300)).optional(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const HealthCheckResponseSchema = z
  .object({
    status: z.literal('ok'),
    timestamp: IsoDateTimeSchema,
  })
  .strict();

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

export const ReadinessCheckResponseSchema = z
  .object({
    status: z.literal('ready'),
    database: z.literal('connected'),
    timestamp: IsoDateTimeSchema,
  })
  .strict();

export type ReadinessCheckResponse = z.infer<typeof ReadinessCheckResponseSchema>;
