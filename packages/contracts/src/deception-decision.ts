import { z } from 'zod';
import {
  UuidSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  FalseRouteIdentifierSchema,
  PolicyIdentifierSchema,
} from './primitives.js';
import { ContainmentModeSchema } from './intrusion-event.js';
import { ModelEnrichmentResultSchema, DegradedModelResultSchema } from './enrichment.js';

/**
 * Audit metadata recording the rule version and evaluation timing.
 */
export const DecisionAuditMetadataSchema = z
  .object({
    ruleVersion: z.string().min(1).max(32),
    evaluatedAt: IsoDateTimeSchema,
  })
  .strict();

export type DecisionAuditMetadata = z.infer<typeof DecisionAuditMetadataSchema>;

/**
 * Base shared fields for a deterministic deception decision.
 */
const BaseDecisionSchema = z.object({
  id: UuidSchema,
  eventId: UuidSchema,
  correlationId: CorrelationIdSchema,
  containmentMode: ContainmentModeSchema,
  matchedPolicy: PolicyIdentifierSchema,
  reason: z.string().min(1).max(1000),
  decisionProvenance: z.literal('DERIVED'),
  decidedAt: IsoDateTimeSchema,
  modelEnrichment: z.union([ModelEnrichmentResultSchema, DegradedModelResultSchema]).optional(),
  auditRecord: DecisionAuditMetadataSchema,
});

/**
 * Refinement predicate enforcing provenance and correlation integrity:
 * Any associated model enrichment must share the exact same correlationId as the decision.
 */
const checkDecisionCorrelation = (data: {
  correlationId: string;
  modelEnrichment?: { correlationId: string } | undefined;
}) => {
  if (!data.modelEnrichment) return true;
  return data.modelEnrichment.correlationId === data.correlationId;
};

const correlationIntegrityParams = {
  message: 'Decision correlationId must match modelEnrichment correlationId',
  path: ['modelEnrichment', 'correlationId'],
};

/**
 * Decision assigning traffic to a false route.
 * Requires an application-allowlisted false route destination.
 */
const RawAssignFalseRouteDecisionSchema = BaseDecisionSchema.extend({
  action: z.literal('ASSIGN_FALSE_ROUTE'),
  assignedFalseRoute: FalseRouteIdentifierSchema,
}).strict();

export const AssignFalseRouteDecisionSchema = RawAssignFalseRouteDecisionSchema.refine(
  checkDecisionCorrelation,
  correlationIntegrityParams,
);
export type AssignFalseRouteDecision = z.infer<typeof RawAssignFalseRouteDecisionSchema>;

/**
 * Decision allowing traffic without false-route assignment.
 * Prohibits assignedFalseRoute to prevent contradictory states.
 */
const RawAllowDecisionSchema = BaseDecisionSchema.extend({
  action: z.literal('ALLOW'),
  assignedFalseRoute: z.undefined().optional(),
}).strict();

export const AllowDecisionSchema = RawAllowDecisionSchema.refine(
  checkDecisionCorrelation,
  correlationIntegrityParams,
);
export type AllowDecision = z.infer<typeof RawAllowDecisionSchema>;

/**
 * Decision alerting the operator without false-route assignment.
 * Prohibits assignedFalseRoute to prevent contradictory states.
 */
const RawAlertOperatorDecisionSchema = BaseDecisionSchema.extend({
  action: z.literal('ALERT_OPERATOR'),
  assignedFalseRoute: z.undefined().optional(),
}).strict();

export const AlertOperatorDecisionSchema = RawAlertOperatorDecisionSchema.refine(
  checkDecisionCorrelation,
  correlationIntegrityParams,
);
export type AlertOperatorDecision = z.infer<typeof RawAlertOperatorDecisionSchema>;

/**
 * Decision placing the session in observation without false-route assignment.
 * Prohibits assignedFalseRoute to prevent contradictory states.
 */
const RawObserveDecisionSchema = BaseDecisionSchema.extend({
  action: z.literal('OBSERVE'),
  assignedFalseRoute: z.undefined().optional(),
}).strict();

export const ObserveDecisionSchema = RawObserveDecisionSchema.refine(
  checkDecisionCorrelation,
  correlationIntegrityParams,
);
export type ObserveDecision = z.infer<typeof RawObserveDecisionSchema>;

/**
 * Persisted deterministic deception decision.
 * Discriminated union on `action` ensuring route assignments and non-route actions
 * cannot contain contradictory false-route properties, with correlation integrity
 * enforced across all decision variants.
 */
export const DeceptionDecisionSchema = z
  .discriminatedUnion('action', [
    RawAssignFalseRouteDecisionSchema,
    RawAllowDecisionSchema,
    RawAlertOperatorDecisionSchema,
    RawObserveDecisionSchema,
  ])
  .refine(checkDecisionCorrelation, correlationIntegrityParams);

export type DeceptionDecision = z.infer<typeof DeceptionDecisionSchema>;
