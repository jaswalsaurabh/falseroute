import {
  type IntrusionEventEnvelope,
  type AutonomousModelAnalysisResult,
  type AutonomousDegradedModelResult,
  type ToolCall,
  SCENARIO_CATALOG,
  validateScenarioEvidence,
} from '@false-route/contracts';

export type PolicyOutcome = 'AUTHORIZED' | 'NARROWED' | 'REJECTED';
export type ActionOrigin = 'MODEL_REQUEST' | 'POLICY_FALLBACK' | 'MANDATORY_RULE';

export interface ModelRequestEvaluation {
  readonly requestedTool: ToolCall;
  readonly outcome: PolicyOutcome;
  readonly policyReason: string;
  readonly canonicalToolCall?: ToolCall | undefined;
}

export interface CanonicalActionPlan {
  readonly toolCall: ToolCall;
  readonly outcome: 'AUTHORIZED' | 'NARROWED';
  readonly policyReason: string;
  readonly origin: ActionOrigin;
}

export interface AutonomousPolicyEvaluation {
  readonly modelDisposition: 'VALID_ANALYSIS' | 'DEGRADED' | 'IGNORED';
  readonly scenarioKind: string;
  readonly isNegativeControl: boolean;
  readonly isPositiveMatch: boolean;
  readonly requestEvaluations: readonly ModelRequestEvaluation[];
  readonly canonicalActionPlans: readonly CanonicalActionPlan[];
  readonly canonicalActionsToExecute: readonly ToolCall[];
}

interface EvaluatedAction {
  outcome: 'AUTHORIZED' | 'NARROWED';
  policyReason: string;
  canonical: ToolCall;
}

export function evaluateAutonomousPolicy(
  envelope: IntrusionEventEnvelope,
  modelAnalysis: AutonomousModelAnalysisResult | AutonomousDegradedModelResult,
): AutonomousPolicyEvaluation {
  const { scenarioKind } = envelope;
  const evidenceValidation = validateScenarioEvidence(scenarioKind, envelope.evidence);
  const evidence = evidenceValidation.success ? evidenceValidation.data : null;
  const isNegativeControl = evidence?.isNegativeControl ?? false;
  const isPositiveMatch = evidence?.isPositiveMatch ?? true;
  const preset = SCENARIO_CATALOG[scenarioKind];

  const requestEvaluations: ModelRequestEvaluation[] = [];
  const seenToolNames = new Set<string>();
  const isModelSuccess = modelAnalysis.status === 'SUCCESS';
  const modelRequests = isModelSuccess ? modelAnalysis.toolRequests : [];
  const isLowConfidence = isModelSuccess && modelAnalysis.confidence < 0.5;

  if (isNegativeControl || !isPositiveMatch) {
    for (const req of modelRequests) {
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'REJECTED',
        policyReason:
          'Negative control or baseline traffic: zero deception or containment actions authorized',
      });
    }
    return {
      modelDisposition: isModelSuccess ? 'VALID_ANALYSIS' : 'DEGRADED',
      scenarioKind,
      isNegativeControl: true,
      isPositiveMatch: false,
      requestEvaluations,
      canonicalActionPlans: [],
      canonicalActionsToExecute: [],
    };
  }

  const modelActionMap = new Map<string, EvaluatedAction>();

  if (isModelSuccess) {
    let reqIndex = 0;
    for (const req of modelRequests) {
      reqIndex++;
      if (reqIndex > 5) {
        requestEvaluations.push({
          requestedTool: req,
          outcome: 'REJECTED',
          policyReason: 'Tool request exceeds maximum per-event request ceiling (5)',
        });
        continue;
      }
      if (seenToolNames.has(req.toolName)) {
        requestEvaluations.push({
          requestedTool: req,
          outcome: 'REJECTED',
          policyReason: `Duplicate request for ${req.toolName} rejected`,
        });
        continue;
      }
      seenToolNames.add(req.toolName);

      if (isLowConfidence) {
        requestEvaluations.push({
          requestedTool: req,
          outcome: 'REJECTED',
          policyReason: `Model confidence ${modelAnalysis.confidence.toFixed(2)} is below minimum threshold (0.50)`,
        });
        continue;
      }

      evaluateSingleModelRequest(req, envelope, preset, requestEvaluations, modelActionMap);
    }
  }

  const canonicalActionPlans = buildCanonicalActionPlans(envelope, preset, modelActionMap);
  const canonicalActionsToExecute = canonicalActionPlans.map((p) => p.toolCall);

  return {
    modelDisposition: isModelSuccess ? 'VALID_ANALYSIS' : 'DEGRADED',
    scenarioKind,
    isNegativeControl: false,
    isPositiveMatch: true,
    requestEvaluations,
    canonicalActionPlans,
    canonicalActionsToExecute,
  };
}

function matchesCanonical(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([k, v]) => actual[k] === v);
}

function buildCanonicalToolCall(
  toolName: string,
  envelope: IntrusionEventEnvelope,
  preset: (typeof SCENARIO_CATALOG)[keyof typeof SCENARIO_CATALOG],
  requestedAt = new Date().toISOString(),
): { canonical: ToolCall; authReason: string; narrowReason: string } | null {
  const { eventId, scenarioKind, sourceIp } = envelope;

  switch (toolName) {
    case 'request_decoy_deployment': {
      if (!preset.allowedActions.includes('DEPLOY_DECOY') || !preset.decoyTemplate) return null;
      return {
        canonical: {
          toolCallId: `${eventId}-deploy`,
          toolName,
          parameters: {
            eventId,
            templateName: preset.decoyTemplate,
            region: 'us-central1',
            ttlSeconds: preset.defaultTtlSeconds,
            reason: `Autonomous response for ${scenarioKind}`,
          },
          requestedAt,
        },
        authReason: 'Allowlisted Cloud Run decoy deployment authorized',
        narrowReason:
          'Narrowed decoy deployment parameters to allowlisted template and catalog configuration',
      };
    }
    case 'request_false_route_assignment': {
      if (
        !preset.allowedActions.includes('ASSIGN_FALSE_ROUTE') &&
        scenarioKind !== 'DECOY_CREDENTIAL_USE'
      ) {
        return null;
      }
      const targetDecoy = preset.decoyTemplate ?? 'mock-admin-decoy';
      const reason =
        scenarioKind === 'DECOY_CREDENTIAL_USE'
          ? 'Mandatory POLICY_DECOY_CREDENTIAL_DIVERSION containment'
          : `Autonomous diversion for ${scenarioKind}`;
      return {
        canonical: {
          toolCallId: `${eventId}-route`,
          toolName,
          parameters: {
            eventId,
            sourceIp,
            targetDecoyService: targetDecoy,
            ttlSeconds: preset.defaultTtlSeconds,
            reason,
          },
          requestedAt,
        },
        authReason: 'Controlled false-route diversion authorized',
        narrowReason:
          'Narrowed false-route diversion parameters to validated source and target decoy',
      };
    }
    case 'request_source_quarantine': {
      if (!preset.allowedActions.includes('QUARANTINE_SOURCE')) return null;
      const cidrPrefix = sourceIp.includes(':') ? 128 : 32;
      return {
        canonical: {
          toolCallId: `${eventId}-quarantine`,
          toolName,
          parameters: {
            eventId,
            sourceIp,
            cidrPrefix,
            ttlSeconds: preset.defaultTtlSeconds,
            reason: `Autonomous quarantine for ${scenarioKind}`,
          },
          requestedAt,
        },
        authReason: 'Dedicated Cloud Armor source quarantine authorized',
        narrowReason: `Narrowed quarantine parameters to strict /${cidrPrefix} mask for validated source`,
      };
    }
    case 'request_operator_alert': {
      if (
        !preset.allowedActions.includes('ALERT_OPERATOR') &&
        scenarioKind !== 'DECOY_CREDENTIAL_USE'
      ) {
        return null;
      }
      const severity =
        scenarioKind === 'DECOY_CREDENTIAL_USE' || preset.maxRiskScore > 90 ? 'CRITICAL' : 'HIGH';
      const headline =
        scenarioKind === 'DECOY_CREDENTIAL_USE'
          ? 'Decoy Credential Triggered'
          : `Incident Detected: ${preset.title}`;
      const details =
        scenarioKind === 'DECOY_CREDENTIAL_USE'
          ? `Source ${sourceIp} accessed decoy credentials; assigned false route to mock-admin-decoy`
          : `Source ${sourceIp} triggered ${preset.expectedPolicy}`;
      return {
        canonical: {
          toolCallId: `${eventId}-alert`,
          toolName,
          parameters: { eventId, severity, headline, details },
          requestedAt,
        },
        authReason: 'Operator alert authorized under incident response policy',
        narrowReason:
          'Narrowed operator alert parameters to canonical incident details and severity',
      };
    }
    default:
      return null;
  }
}

function evaluateSingleModelRequest(
  req: ToolCall,
  envelope: IntrusionEventEnvelope,
  preset: (typeof SCENARIO_CATALOG)[keyof typeof SCENARIO_CATALOG],
  requestEvaluations: ModelRequestEvaluation[],
  modelActionMap: Map<string, EvaluatedAction>,
): void {
  const { eventId, scenarioKind } = envelope;
  const p = req.parameters;

  if (req.toolName === 'recommend_response_plan') {
    if (p['eventId'] !== eventId) {
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'REJECTED',
        policyReason: `Response plan eventId does not match envelope eventId ${eventId}`,
      });
      return;
    }
    const rawActions = Array.isArray(p['recommendedActions'])
      ? (p['recommendedActions'] as string[])
      : [];
    const allowedActions: readonly string[] =
      scenarioKind === 'DECOY_CREDENTIAL_USE'
        ? ['ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR']
        : preset.allowedActions;
    const validActions = rawActions.filter((a) => allowedActions.includes(a));
    const unauthorizedActions = rawActions.filter((a) => !allowedActions.includes(a));

    if (validActions.length === 0) {
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'REJECTED',
        policyReason: `Response plan recommended actions [${rawActions.join(', ')}] conflict with allowed actions for scenario ${scenarioKind}`,
      });
    } else if (unauthorizedActions.length > 0 || rawActions.length !== allowedActions.length) {
      const canonical: ToolCall = {
        toolCallId: req.toolCallId,
        toolName: 'recommend_response_plan',
        parameters: {
          eventId,
          recommendedActions: validActions,
          rationale:
            typeof p['rationale'] === 'string'
              ? p['rationale']
              : `Response plan for ${scenarioKind}`,
          confidence: typeof p['confidence'] === 'number' ? p['confidence'] : 0.8,
        },
        requestedAt: req.requestedAt,
      };
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'NARROWED',
        policyReason:
          unauthorizedActions.length > 0
            ? `Narrowed response plan recommendations to remove unauthorized actions: [${unauthorizedActions.join(', ')}]`
            : 'Narrowed response plan recommendations to scenario-authorized actions',
        canonicalToolCall: canonical,
      });
    } else {
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'AUTHORIZED',
        policyReason: 'Advisory response plan authorized and aligned with scenario catalog',
      });
    }
    return;
  }

  const built = buildCanonicalToolCall(req.toolName, envelope, preset, req.requestedAt);
  if (!built) {
    const isQuarantine = req.toolName === 'request_source_quarantine';
    requestEvaluations.push({
      requestedTool: req,
      outcome: 'REJECTED',
      policyReason: isQuarantine
        ? `Source quarantine rejected: scenario ${scenarioKind} requires deception routing, not quarantine`
        : `${req.toolName} not authorized for scenario ${scenarioKind}`,
    });
    return;
  }

  const match = matchesCanonical(p, built.canonical.parameters);
  const outcome: PolicyOutcome = match ? 'AUTHORIZED' : 'NARROWED';
  const policyReason = match ? built.authReason : built.narrowReason;
  requestEvaluations.push({
    requestedTool: req,
    outcome,
    policyReason,
    canonicalToolCall: built.canonical,
  });
  modelActionMap.set(req.toolName, { outcome, policyReason, canonical: built.canonical });
}

function buildCanonicalActionPlans(
  envelope: IntrusionEventEnvelope,
  preset: (typeof SCENARIO_CATALOG)[keyof typeof SCENARIO_CATALOG],
  modelActionMap: Map<string, EvaluatedAction>,
): CanonicalActionPlan[] {
  const plans: CanonicalActionPlan[] = [];
  const actionTools = [
    'request_decoy_deployment',
    'request_false_route_assignment',
    'request_source_quarantine',
    'request_operator_alert',
  ];

  for (const toolName of actionTools) {
    const built = buildCanonicalToolCall(toolName, envelope, preset);
    if (!built) continue;

    const evaluated = modelActionMap.get(toolName);
    if (evaluated) {
      plans.push({
        toolCall: evaluated.canonical,
        outcome: evaluated.outcome,
        policyReason: evaluated.policyReason,
        origin: 'MODEL_REQUEST',
      });
    } else {
      plans.push({
        toolCall: built.canonical,
        outcome: 'AUTHORIZED',
        policyReason:
          envelope.scenarioKind === 'DECOY_CREDENTIAL_USE'
            ? built.authReason
            : `Canonical ${toolName.replace('request_', '').replace(/_/g, ' ')} authorized from authoritative scenario catalog`,
        origin:
          envelope.scenarioKind === 'DECOY_CREDENTIAL_USE' ? 'MANDATORY_RULE' : 'POLICY_FALLBACK',
      });
    }
  }

  return plans;
}
