import { z } from 'zod';
import {
  ConfidenceScoreSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  ResponseActionSchema,
  UuidSchema,
} from './primitives.js';
import { ProvenanceClassificationSchema } from './provenance.js';
import { ScenarioKindSchema } from './scenario.js';

// These identifiers are references, not free-form model output. Keeping them
// short and printable makes them safe to persist and render in an operator UI.
export const EvidenceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

export const IncidentStageSchema = z.enum([
  'RECONNAISSANCE',
  'EXPLOITATION_ATTEMPT',
  'CREDENTIAL_ATTACK',
  'DECEPTION_ENGAGEMENT',
  'CONTAINMENT_CANDIDATE',
  'INSUFFICIENT_EVIDENCE',
]);
export type IncidentStage = z.infer<typeof IncidentStageSchema>;

export const RiskTierSchema = z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const ContextCompletenessSchema = z.enum(['COMPLETE', 'PARTIAL', 'INSUFFICIENT']);
export type ContextCompleteness = z.infer<typeof ContextCompletenessSchema>;

export const ActionOriginSchema = z.enum([
  'MODEL_REQUEST',
  'MANDATORY_RULE',
  'POLICY_FALLBACK',
  'DEGRADED_FALLBACK',
]);
export type ActionOrigin = z.infer<typeof ActionOriginSchema>;

export const IncidentEvidenceReferenceSchema = z
  .object({
    evidenceId: EvidenceIdSchema,
    evidenceType: z.string().min(1).max(64),
    observedAt: IsoDateTimeSchema,
    provenance: ProvenanceClassificationSchema,
  })
  .strict();
export type IncidentEvidenceReference = z.infer<typeof IncidentEvidenceReferenceSchema>;

export const IncidentSignalSummarySchema = z
  .object({
    signalId: EvidenceIdSchema,
    scenarioKind: ScenarioKindSchema,
    summary: z.string().min(1).max(300),
    observedAt: IsoDateTimeSchema,
    evidenceRefs: z.array(EvidenceIdSchema).min(1).max(5),
  })
  .strict();
export type IncidentSignalSummary = z.infer<typeof IncidentSignalSummarySchema>;

export const PriorPolicyOutcomeSchema = z
  .object({
    action: ResponseActionSchema,
    outcome: z.enum(['AUTHORIZED', 'REJECTED', 'NARROWED']),
    origin: ActionOriginSchema,
    evaluatedAt: IsoDateTimeSchema,
  })
  .strict();
export type PriorPolicyOutcome = z.infer<typeof PriorPolicyOutcomeSchema>;

export const SimulatedLeaseSummarySchema = z
  .object({
    leaseId: UuidSchema,
    resourceType: z.enum(['DECOY', 'FALSE_ROUTE', 'QUARANTINE']),
    status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'PENDING_CLEANUP', 'CLEANED_UP']),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();
export type SimulatedLeaseSummary = z.infer<typeof SimulatedLeaseSummarySchema>;

export const IncidentContextSchema = z
  .object({
    contextSchemaVersion: z.literal('1.0.0'),
    currentEventId: UuidSchema,
    correlationId: CorrelationIdSchema,
    scenarioKind: ScenarioKindSchema,
    syntheticSource: z.string().min(1).max(64),
    signals: z.array(IncidentSignalSummarySchema).min(1).max(5),
    evidence: z.array(IncidentEvidenceReferenceSchema).min(1).max(5),
    priorPolicyOutcomes: z.array(PriorPolicyOutcomeSchema).max(5),
    activeLeases: z.array(SimulatedLeaseSummarySchema).max(5),
    campaignId: UuidSchema.optional(),
    campaignStep: z.number().int().min(1).max(10).optional(),
    campaignTotalSteps: z.number().int().min(1).max(10).optional(),
    contextCompleteness: ContextCompletenessSchema,
  })
  .strict()
  .superRefine((context, refinement) => {
    const evidenceIds = new Set(context.evidence.map((evidence) => evidence.evidenceId));
    const signalEvidenceIds = context.signals.flatMap((signal) => signal.evidenceRefs);
    if (signalEvidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signals'],
        message: 'Every signal evidence reference must exist in evidence',
      });
    }
    if (context.campaignStep !== undefined && context.campaignTotalSteps === undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['campaignTotalSteps'],
        message: 'campaignTotalSteps is required when campaignStep is present',
      });
    }
    if (
      context.campaignStep !== undefined &&
      context.campaignTotalSteps !== undefined &&
      context.campaignStep > context.campaignTotalSteps
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['campaignStep'],
        message: 'campaignStep cannot exceed campaignTotalSteps',
      });
    }
  });
export type IncidentContext = z.infer<typeof IncidentContextSchema>;

export const IncidentAssessmentSchema = z
  .object({
    incidentStage: IncidentStageSchema,
    riskTier: RiskTierSchema,
    confidence: ConfidenceScoreSchema,
    hypothesis: z.string().min(1).max(500),
    evidenceRefs: z.array(EvidenceIdSchema).min(1).max(5),
    recommendedActions: z.array(ResponseActionSchema).min(1).max(5),
    rationale: z.string().min(1).max(1000),
    needsFollowUp: z.boolean(),
  })
  .strict();
export type IncidentAssessment = z.infer<typeof IncidentAssessmentSchema>;

export function validateIncidentAssessment(
  assessment: unknown,
  context: IncidentContext,
): { success: true; data: IncidentAssessment } | { success: false; error: string } {
  const parsed = IncidentAssessmentSchema.safeParse(assessment);
  if (!parsed.success) return { success: false, error: parsed.error.message };

  const availableEvidence = new Set(context.evidence.map((evidence) => evidence.evidenceId));
  if (parsed.data.evidenceRefs.some((evidenceId) => !availableEvidence.has(evidenceId))) {
    return {
      success: false,
      error: 'Assessment contains an evidence reference absent from context',
    };
  }
  return parsed;
}
