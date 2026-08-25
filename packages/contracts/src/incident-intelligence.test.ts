import { describe, expect, it } from 'vitest';
import {
  IncidentAssessmentSchema,
  IncidentContextSchema,
  ScenarioActionOwnershipSchema,
  validateIncidentAssessment,
} from './index.js';

const context = {
  contextSchemaVersion: '1.0.0' as const,
  currentEventId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'corr-not-a-real-001',
  scenarioKind: 'ENV_FILE_PROBE' as const,
  syntheticSource: 'local-simulator',
  signals: [
    {
      signalId: 'signal-1',
      scenarioKind: 'ENV_FILE_PROBE' as const,
      summary: 'Synthetic .env probe matched',
      observedAt: '2026-08-24T00:00:00.000Z',
      evidenceRefs: ['evidence-1'],
    },
  ],
  evidence: [
    {
      evidenceId: 'evidence-1',
      evidenceType: 'ENV_FILE_MATCH',
      observedAt: '2026-08-24T00:00:00.000Z',
      provenance: 'OBSERVED' as const,
    },
  ],
  priorPolicyOutcomes: [],
  activeLeases: [],
  contextCompleteness: 'COMPLETE' as const,
};

const assessment = {
  incidentStage: 'RECONNAISSANCE' as const,
  riskTier: 'HIGH' as const,
  confidence: 0.8,
  hypothesis: 'The synthetic source is probing for exposed configuration.',
  evidenceRefs: ['evidence-1'],
  recommendedActions: ['ALERT_OPERATOR' as const],
  rationale: 'The observed match supports an alert.',
  needsFollowUp: true,
};

describe('AI incident and action contracts', () => {
  it('accepts bounded synthetic context and assessment fixtures', () => {
    expect(IncidentContextSchema.safeParse(context).success).toBe(true);
    expect(IncidentAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(validateIncidentAssessment(assessment, context).success).toBe(true);
  });

  it('rejects unknown keys, invalid evidence references, and oversized rationale', () => {
    expect(IncidentContextSchema.safeParse({ ...context, injected: 'dummy' }).success).toBe(false);
    expect(
      validateIncidentAssessment({ ...assessment, evidenceRefs: ['missing-evidence'] }, context)
        .success,
    ).toBe(false);
    expect(
      IncidentAssessmentSchema.safeParse({ ...assessment, rationale: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });

  it('rejects context bounds and unsupported response actions', () => {
    expect(
      IncidentContextSchema.safeParse({
        ...context,
        signals: Array.from({ length: 6 }, (_, index) => ({
          ...context.signals[0],
          signalId: `signal-${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      IncidentAssessmentSchema.safeParse({
        ...assessment,
        recommendedActions: ['RUN_UNRESTRICTED_COMMAND'],
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory action ownership controls', () => {
    expect(
      ScenarioActionOwnershipSchema.safeParse({
        mandatoryActions: ['ALERT_OPERATOR'],
        optionalActions: ['ALERT_OPERATOR'],
        forbiddenActions: [],
        degradedFallbackActions: [],
      }).success,
    ).toBe(false);
  });
});
