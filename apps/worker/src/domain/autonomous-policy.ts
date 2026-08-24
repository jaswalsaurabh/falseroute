import {
  type IntrusionEventEnvelope,
  type AutonomousModelAnalysisResult,
  type AutonomousDegradedModelResult,
  type ToolCall,
  type ResponseAction,
  type ActionOrigin,
  SCENARIO_CATALOG,
  validateScenarioEvidence,
} from '@false-route/contracts';

export type PolicyOutcome = 'AUTHORIZED' | 'NARROWED' | 'REJECTED';

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

  const canonicalActionPlans = buildCanonicalActionPlans(
    envelope,
    preset,
    modelActionMap,
    isModelSuccess && !isLowConfidence,
  );
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
  toolName: ToolCall['toolName'],
  envelope: IntrusionEventEnvelope,
  preset: (typeof SCENARIO_CATALOG)[keyof typeof SCENARIO_CATALOG],
  requestedAt = new Date().toISOString(),
): { canonical: ToolCall; authReason: string; narrowReason: string } | null {
  const { eventId, scenarioKind, sourceIp } = envelope;

  const action = actionForToolName(toolName);
  if (!action || preset.actionOwnership.forbiddenActions.includes(action)) return null;

  switch (toolName) {
    case 'request_decoy_deployment': {
      if (
        !preset.actionOwnership.optionalActions.includes('DEPLOY_DECOY') &&
        !preset.actionOwnership.mandatoryActions.includes('DEPLOY_DECOY') &&
        !preset.actionOwnership.degradedFallbackActions.includes('DEPLOY_DECOY')
      )
        return null;
      if (!preset.decoyTemplate) return null;
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
        !preset.actionOwnership.optionalActions.includes('ASSIGN_FALSE_ROUTE') &&
        !preset.actionOwnership.mandatoryActions.includes('ASSIGN_FALSE_ROUTE') &&
        !preset.actionOwnership.degradedFallbackActions.includes('ASSIGN_FALSE_ROUTE')
      )
        return null;
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
      if (
        !preset.actionOwnership.optionalActions.includes('QUARANTINE_SOURCE') &&
        !preset.actionOwnership.mandatoryActions.includes('QUARANTINE_SOURCE') &&
        !preset.actionOwnership.degradedFallbackActions.includes('QUARANTINE_SOURCE')
      )
        return null;
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
        !preset.actionOwnership.optionalActions.includes('ALERT_OPERATOR') &&
        !preset.actionOwnership.mandatoryActions.includes('ALERT_OPERATOR') &&
        !preset.actionOwnership.degradedFallbackActions.includes('ALERT_OPERATOR')
      )
        return null;
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

function actionForToolName(toolName: ToolCall['toolName']): ResponseAction | null {
  switch (toolName) {
    case 'request_decoy_deployment':
      return 'DEPLOY_DECOY';
    case 'request_false_route_assignment':
      return 'ASSIGN_FALSE_ROUTE';
    case 'request_source_quarantine':
      return 'QUARANTINE_SOURCE';
    case 'request_operator_alert':
      return 'ALERT_OPERATOR';
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
    const ownership = preset.actionOwnership;
    const selectableActions = [...ownership.mandatoryActions, ...ownership.optionalActions];
    const validActions = rawActions.filter((a): a is ResponseAction =>
      selectableActions.includes(a as ResponseAction),
    );
    const unauthorizedActions = rawActions.filter(
      (a) =>
        !selectableActions.includes(a as ResponseAction) ||
        ownership.forbiddenActions.includes(a as ResponseAction),
    );

    if (validActions.length === 0) {
      requestEvaluations.push({
        requestedTool: req,
        outcome: 'REJECTED',
        policyReason: `Response plan recommended actions [${rawActions.join(', ')}] conflict with allowed actions for scenario ${scenarioKind}`,
      });
    } else if (unauthorizedActions.length > 0 || rawActions.length !== selectableActions.length) {
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

  const action = actionForToolName(req.toolName);
  const built = buildCanonicalToolCall(req.toolName, envelope, preset, req.requestedAt);
  if (!built) {
    const isQuarantine = req.toolName === 'request_source_quarantine';
    requestEvaluations.push({
      requestedTool: req,
      outcome: 'REJECTED',
      policyReason:
        action && preset.actionOwnership.forbiddenActions.includes(action as never)
          ? `${action} is forbidden for scenario ${scenarioKind}`
          : isQuarantine
            ? `Source quarantine rejected: scenario ${scenarioKind} does not own QUARANTINE_SOURCE`
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
  if (action && preset.actionOwnership.optionalActions.includes(action as never)) {
    modelActionMap.set(req.toolName, { outcome, policyReason, canonical: built.canonical });
  } else {
    requestEvaluations[requestEvaluations.length - 1] = {
      requestedTool: req,
      outcome: 'NARROWED',
      policyReason: `${action} is mandatory and remains owned by deterministic policy`,
      canonicalToolCall: built.canonical,
    };
  }
}

function buildCanonicalActionPlans(
  envelope: IntrusionEventEnvelope,
  preset: (typeof SCENARIO_CATALOG)[keyof typeof SCENARIO_CATALOG],
  modelActionMap: Map<string, EvaluatedAction>,
  modelAvailable: boolean,
): CanonicalActionPlan[] {
  const plans: CanonicalActionPlan[] = [];
  const actionTools: ToolCall['toolName'][] = [
    'request_decoy_deployment',
    'request_false_route_assignment',
    'request_source_quarantine',
    'request_operator_alert',
  ];

  for (const toolName of actionTools) {
    const built = buildCanonicalToolCall(toolName, envelope, preset);
    if (!built) continue;

    const action = actionForToolName(toolName);
    const evaluated = modelActionMap.get(toolName);
    const isDegradedFallback =
      !modelAvailable &&
      action !== null &&
      preset.actionOwnership.degradedFallbackActions.includes(action as never);
    const isMandatory =
      action !== null && preset.actionOwnership.mandatoryActions.includes(action as never);

    if (evaluated && !isMandatory) {
      plans.push({
        toolCall: evaluated.canonical,
        outcome: evaluated.outcome,
        policyReason: evaluated.policyReason,
        origin: 'MODEL_REQUEST',
      });
    } else if (isMandatory || isDegradedFallback) {
      const origin: ActionOrigin = isDegradedFallback ? 'DEGRADED_FALLBACK' : 'MANDATORY_RULE';
      plans.push({
        toolCall: built.canonical,
        outcome: 'AUTHORIZED',
        policyReason: isMandatory
          ? built.authReason
          : `Conservative ${toolName.replace('request_', '').replace(/_/g, ' ')} selected because Gemini analysis was unavailable, invalid, or below the confidence threshold`,
        origin,
      });
    }
  }

  return plans;
}
