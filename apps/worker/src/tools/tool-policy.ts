import {
  type ToolCall,
  type ScenarioKind,
  RecommendResponsePlanParamsSchema,
  RequestDecoyDeploymentParamsSchema,
  RequestFalseRouteAssignmentParamsSchema,
  RequestSourceQuarantineParamsSchema,
  RequestOperatorAlertParamsSchema,
} from '@false-route/contracts';

export interface ToolExecutionContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly scenarioKind: ScenarioKind;
  readonly sourceIp: string;
  readonly isPositiveMatch: boolean;
  readonly isNegativeControl: boolean;
}

export interface PolicyDecision {
  readonly authorized: boolean;
  readonly reason: string;
}

export interface ParameterValidationResult {
  readonly success: boolean;
  readonly error?: string | undefined;
}

const PARAMETER_SCHEMAS: Record<string, { parse: (val: unknown) => unknown }> = {
  recommend_response_plan: RecommendResponsePlanParamsSchema,
  request_decoy_deployment: RequestDecoyDeploymentParamsSchema,
  request_false_route_assignment: RequestFalseRouteAssignmentParamsSchema,
  request_source_quarantine: RequestSourceQuarantineParamsSchema,
  request_operator_alert: RequestOperatorAlertParamsSchema,
};

export function validateToolParameters(
  toolCall: ToolCall,
  context: ToolExecutionContext,
): ParameterValidationResult {
  try {
    PARAMETER_SCHEMAS[toolCall.toolName]?.parse(toolCall.parameters);

    if (toolCall.parameters['eventId'] !== context.eventId) {
      return { success: false, error: 'Tool parameter eventId must match the envelope eventId' };
    }
    if (
      typeof toolCall.parameters['sourceIp'] === 'string' &&
      toolCall.parameters['sourceIp'] !== context.sourceIp
    ) {
      return { success: false, error: 'Tool parameter sourceIp must match validated evidence' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function evaluateToolPolicy(
  toolName: string,
  context: ToolExecutionContext,
): PolicyDecision {
  const { scenarioKind, isNegativeControl, isPositiveMatch } = context;
  if (isNegativeControl || !isPositiveMatch) {
    return {
      authorized: false,
      reason:
        'Negative control evidence rejected: no containment or deception authorized for baseline traffic',
    };
  }

  if (scenarioKind === 'DECOY_CREDENTIAL_USE') {
    if (toolName === 'request_source_quarantine') {
      return {
        authorized: false,
        reason: 'DECOY_CREDENTIAL_USE requires deception route, not source quarantine',
      };
    }
    return {
      authorized: true,
      reason: 'Deterministic POLICY_DECOY_CREDENTIAL_DIVERSION authorized',
    };
  }

  if (
    scenarioKind === 'ENV_FILE_PROBE' ||
    scenarioKind === 'WORDPRESS_CONFIG_PROBE' ||
    scenarioKind === 'PATH_TRAVERSAL_PROBE'
  ) {
    if (toolName === 'request_source_quarantine') {
      return {
        authorized: false,
        reason: 'Configuration probe scenarios divert to decoy before quarantine threshold',
      };
    }
    return { authorized: true, reason: 'Deterministic containment policy authorized' };
  }

  if (
    scenarioKind === 'SUSPICIOUS_IP_BURST' ||
    scenarioKind === 'SIP_INVITE_FLOOD' ||
    scenarioKind === 'TOKEN_TAMPER'
  ) {
    if (toolName === 'request_decoy_deployment' || toolName === 'request_false_route_assignment') {
      return {
        authorized: false,
        reason: 'Volumetric and token tamper incidents require quarantine, not web decoy',
      };
    }
    return { authorized: true, reason: 'Deterministic quarantine policy authorized' };
  }

  return { authorized: true, reason: 'General policy evaluation passed' };
}

export function estimateSpendUsd(toolName: string): number {
  switch (toolName) {
    case 'request_decoy_deployment':
      return 0.5;
    case 'request_false_route_assignment':
    case 'request_source_quarantine':
      return 0.1;
    default:
      return 0.0;
  }
}

export function resolveProviderName(toolName: string): string {
  switch (toolName) {
    case 'request_decoy_deployment':
      return 'CLOUD_RUN';
    case 'request_false_route_assignment':
      return 'FALSE_ROUTE';
    case 'request_source_quarantine':
      return 'CLOUD_ARMOR';
    default:
      return 'INTERNAL';
  }
}
