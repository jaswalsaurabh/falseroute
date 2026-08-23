import {
  type IntrusionEvent,
  type DeceptionDecision,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  DeceptionDecisionSchema,
} from '@false-route/contracts';

export const ACTIVE_RULE_VERSION = '2026.08.1';

export interface PolicyEvaluationInput {
  readonly event: IntrusionEvent;
  readonly enrichment?: ModelEnrichmentResult | DegradedModelResult | undefined;
  readonly decisionId: string;
  readonly evaluatedAt?: string;
}

/**
 * Pure deterministic deception policy engine.
 *
 * Rules:
 * 1. An event using 'mock-admin-decoy-creds' deterministically produces ASSIGN_FALSE_ROUTE
 *    targeting 'mock-admin-decoy' in SIMULATED containment mode.
 * 2. Gemini enrichment is untrusted advisory data and cannot override the deterministic policy.
 * 3. Non-decoy events are NEVER assigned false routes, regardless of model recommendation.
 * 4. Decisions carry provenance (DERIVED) and an atomic audit metadata snapshot.
 */
export function evaluateDeceptionPolicy(input: PolicyEvaluationInput): DeceptionDecision {
  const { event, enrichment, decisionId, evaluatedAt = new Date().toISOString() } = input;

  // Correlation integrity verification
  if (enrichment && enrichment.correlationId !== event.correlationId) {
    throw new Error(
      `Correlation mismatch: event (${event.correlationId}) != enrichment (${enrichment.correlationId})`,
    );
  }

  const auditRecord = {
    ruleVersion: ACTIVE_RULE_VERSION,
    evaluatedAt,
  };

  if (event.usedDecoyCredential && event.decoyIdentifier === 'mock-admin-decoy-creds') {
    const rawDecision = {
      id: decisionId,
      eventId: event.id,
      correlationId: event.correlationId,
      action: 'ASSIGN_FALSE_ROUTE' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
      matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER' as const,
      reason:
        'Approved decoy credential mock-admin-decoy-creds accessed target asset. Deterministically assigned simulated false-route containment.',
      containmentMode: 'SIMULATED' as const,
      decisionProvenance: 'DERIVED' as const,
      decidedAt: evaluatedAt,
      modelEnrichment: enrichment,
      auditRecord,
    };

    return DeceptionDecisionSchema.parse(rawDecision);
  }

  // Non-decoy control path: never assign false route
  const isHighRisk =
    event.failedLoginCount >= 5 ||
    event.riskIndicators.some((indicator) =>
      ['RAPID_FAILURE_SEQUENCE', 'SUSPICIOUS_ANOMALY', 'CREDENTIAL_BURST'].includes(indicator),
    );

  const action = isHighRisk ? ('ALERT_OPERATOR' as const) : ('OBSERVE' as const);
  const matchedPolicy = isHighRisk
    ? ('HIGH_RISK_THRESHOLD' as const)
    : ('DEFAULT_OBSERVATION' as const);
  const reason = isHighRisk
    ? 'High risk activity detected without decoy credential trigger. Operator alert raised under simulated containment.'
    : 'Standard activity without decoy credential trigger. Placed under simulated observation.';

  const rawDecision = {
    id: decisionId,
    eventId: event.id,
    correlationId: event.correlationId,
    action,
    matchedPolicy,
    reason,
    containmentMode: 'SIMULATED' as const,
    decisionProvenance: 'DERIVED' as const,
    decidedAt: evaluatedAt,
    modelEnrichment: enrichment,
    auditRecord,
  };

  return DeceptionDecisionSchema.parse(rawDecision);
}
