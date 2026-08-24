import { z } from 'zod';
import {
  CorrelationIdSchema,
  IpAddressSchema,
  IsoDateTimeSchema,
  UuidSchema,
} from './primitives.js';
import { ProvenanceClassificationSchema } from './provenance.js';
import { ScenarioKindSchema, validateScenarioEvidence } from './scenario.js';

export { ResponseActionSchema, type ResponseAction } from './primitives.js';

export const EventSourceSchema = z.enum(['SIMULATOR', 'PUB_SUB', 'GATEWAY', 'OPERATOR', 'WORKER']);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const WorkflowStatusSchema = z.enum([
  'RECEIVED',
  'VALIDATED',
  'ENRICHED',
  'AUTHORIZED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'ROLLED_BACK',
  'EXPIRED',
  'QUARANTINED',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const LeaseStatusSchema = z.enum([
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
  'FAILED',
  'PENDING_CLEANUP',
  'CLEANED_UP',
]);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

export const SystemModeSchema = z.enum(['LOCAL_FAKE', 'DEGRADED', 'SIMULATED', 'LIVE']);
export type SystemMode = z.infer<typeof SystemModeSchema>;

export const IntrusionEventEnvelopeSchema = z
  .object({
    eventId: UuidSchema,
    correlationId: CorrelationIdSchema,
    schemaVersion: z.literal('1.0.0'),
    source: EventSourceSchema,
    scenarioKind: ScenarioKindSchema,
    occurredAt: IsoDateTimeSchema,
    publishedAt: IsoDateTimeSchema,
    sourceIp: IpAddressSchema,
    evidence: z.record(z.string(), z.unknown()),
    provenance: ProvenanceClassificationSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const evidence = validateScenarioEvidence(envelope.scenarioKind, envelope.evidence);
    if (!evidence.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: evidence.error,
      });
      return;
    }

    if (evidence.data.sourceIp !== envelope.sourceIp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'sourceIp'],
        message: 'Evidence sourceIp must match the envelope sourceIp',
      });
    }
  });

export type IntrusionEventEnvelope = z.infer<typeof IntrusionEventEnvelopeSchema>;

export const DeliveryAttemptRecordSchema = z
  .object({
    attemptId: UuidSchema,
    eventId: UuidSchema,
    transportId: z.string().min(1).max(128),
    workerId: z.string().min(1).max(128),
    attemptNumber: z.number().int().min(1),
    status: z.enum(['SUCCESS', 'TRANSIENT_FAILURE', 'TERMINAL_FAILURE']),
    errorMessage: z.string().max(512).optional(),
    attemptedAt: IsoDateTimeSchema,
  })
  .strict();

export type DeliveryAttemptRecord = z.infer<typeof DeliveryAttemptRecordSchema>;

export const ReplayAttemptRecordSchema = z
  .object({
    replayId: UuidSchema,
    originalEventId: UuidSchema,
    originalTransportId: z.string().min(1).max(128),
    newTransportId: z.string().min(1).max(128),
    requestedBy: z.string().min(1).max(128),
    rationale: z.string().min(1).max(512),
    replayedAt: IsoDateTimeSchema,
  })
  .strict();

export type ReplayAttemptRecord = z.infer<typeof ReplayAttemptRecordSchema>;
