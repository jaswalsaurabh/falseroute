import { z } from 'zod';
import { UuidSchema, CorrelationIdSchema, IsoDateTimeSchema } from './primitives.js';
import {
  SimulatedIntrusionEventInputSchema,
  IntrusionEventSchema,
  ProcessingStatusSchema,
} from './intrusion-event.js';
import { DeceptionDecisionSchema, type DeceptionDecision } from './deception-decision.js';
import {
  SimulatedDeceptionEffectSchema,
  type SimulatedDeceptionEffect,
} from './simulated-deception.js';

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

/**
 * Validates cross-field evidence consistency between a decision and its simulated effect.
 */
function validateDecisionAndEffectIntegrity(
  data: {
    decision?: DeceptionDecision | null | undefined;
    simulatedEffect?: SimulatedDeceptionEffect | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const { decision, simulatedEffect } = data;

  if (!decision) {
    if (simulatedEffect !== undefined && simulatedEffect !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'simulatedEffect cannot be present when decision is null or undefined',
        path: ['simulatedEffect'],
      });
    }
    return;
  }

  if (decision.action === 'ASSIGN_FALSE_ROUTE') {
    if (!simulatedEffect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'simulatedEffect is required when decision action is ASSIGN_FALSE_ROUTE',
        path: ['simulatedEffect'],
      });
      return;
    }

    if (simulatedEffect.decisionId !== decision.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `simulatedEffect decisionId (${simulatedEffect.decisionId}) must match decision id (${decision.id})`,
        path: ['simulatedEffect', 'decisionId'],
      });
    }

    if (simulatedEffect.correlationId !== decision.correlationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `simulatedEffect correlationId (${simulatedEffect.correlationId}) must match decision correlationId (${decision.correlationId})`,
        path: ['simulatedEffect', 'correlationId'],
      });
    }

    const assignedTarget = 'assignedFalseRoute' in decision ? decision.assignedFalseRoute : '';
    if (simulatedEffect.assignedFalseRoute !== assignedTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `simulatedEffect assignedFalseRoute (${simulatedEffect.assignedFalseRoute}) must match decision assignedFalseRoute (${assignedTarget})`,
        path: ['simulatedEffect', 'assignedFalseRoute'],
      });
    }

    if (simulatedEffect.containmentMode !== decision.containmentMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `simulatedEffect containmentMode (${simulatedEffect.containmentMode}) must match decision containmentMode (${decision.containmentMode})`,
        path: ['simulatedEffect', 'containmentMode'],
      });
    }
    return;
  }

  if (simulatedEffect !== undefined && simulatedEffect !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `simulatedEffect must not be present when decision action is ${decision.action}`,
      path: ['simulatedEffect'],
    });
  }
}

export const GetIntrusionEventResponseSchema = z
  .object({
    event: IntrusionEventSchema,
    decision: DeceptionDecisionSchema.nullable().optional(),
    simulatedEffect: SimulatedDeceptionEffectSchema.nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.event.status === 'DECIDED') {
      if (!data.decision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'decision is required when event status is DECIDED',
          path: ['decision'],
        });
      }
    } else {
      if (data.decision !== undefined && data.decision !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `decision must be null or undefined when event status is ${data.event.status}`,
          path: ['decision'],
        });
      }
    }

    validateDecisionAndEffectIntegrity(data, ctx);
    if (data.decision && data.decision.eventId !== data.event.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `decision eventId (${data.decision.eventId}) must match event id (${data.event.id})`,
        path: ['decision', 'eventId'],
      });
    }
    if (data.decision && data.decision.correlationId !== data.event.correlationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `decision correlationId (${data.decision.correlationId}) must match event correlationId (${data.event.correlationId})`,
        path: ['decision', 'correlationId'],
      });
    }
  });

export type GetIntrusionEventResponse = z.infer<typeof GetIntrusionEventResponseSchema>;

export const GetDeceptionDecisionResponseSchema = z
  .object({
    decision: DeceptionDecisionSchema,
    simulatedEffect: SimulatedDeceptionEffectSchema.nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateDecisionAndEffectIntegrity(data, ctx);
  });

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
