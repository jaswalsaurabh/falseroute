import { z } from 'zod';
import { CorrelationIdSchema, IsoDateTimeSchema, UuidSchema } from './primitives.js';
import { ProvenanceClassificationSchema } from './provenance.js';
import { SystemModeSchema, WorkflowStatusSchema } from './workflow.js';
import { ToolExecutionStageSchema } from './tool-execution.js';

export const ActivityStageSchema = z.union([WorkflowStatusSchema, ToolExecutionStageSchema]);
export type ActivityStage = z.infer<typeof ActivityStageSchema>;

export const ActivityEventSchema = z
  .object({
    cursor: z.number().int().min(1),
    eventId: UuidSchema,
    correlationId: CorrelationIdSchema,
    stage: ActivityStageSchema,
    eventType: z.string().min(1).max(64),
    summary: z.string().min(1).max(500),
    provenance: ProvenanceClassificationSchema,
    occurredAt: IsoDateTimeSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivitySnapshotResponseSchema = z
  .object({
    events: z.array(ActivityEventSchema),
    latestCursor: z.number().int().min(0),
    systemMode: SystemModeSchema,
    totalCount: z.number().int().min(0),
  })
  .strict();

export type ActivitySnapshotResponse = z.infer<typeof ActivitySnapshotResponseSchema>;

export const SseEventTypeSchema = z.enum(['activity', 'heartbeat', 'system_mode']);
export type SseEventType = z.infer<typeof SseEventTypeSchema>;
