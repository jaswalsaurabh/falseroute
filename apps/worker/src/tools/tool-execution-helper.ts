import {
  type ToolCall,
  type ToolResult,
  type RequestDecoyDeploymentParams,
  type RequestFalseRouteAssignmentParams,
  type RequestSourceQuarantineParams,
} from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  type FakeCloudRunAdapter,
  type FakeFalseRouteAdapter,
  type FakeCloudArmorAdapter,
} from './fake-cloud-adapters.js';
import { type ToolExecutionContext } from './tool-policy.js';

export interface ProviderExecutionResult {
  readonly providerResourceId?: string | undefined;
  readonly details: Record<string, unknown>;
}

export interface ObservedProviderResource {
  readonly resourceId: string;
  readonly details: Record<string, unknown>;
}

export function inspectProviderResource(
  toolCall: ToolCall,
  operationKey: string,
  cloudRun: FakeCloudRunAdapter,
  falseRoute: FakeFalseRouteAdapter,
  cloudArmor: FakeCloudArmorAdapter,
): ObservedProviderResource | null {
  switch (toolCall.toolName) {
    case 'request_decoy_deployment': {
      const decoy = cloudRun.getDecoyByOperation(operationKey);
      if (decoy) {
        return {
          resourceId: decoy.serviceId,
          details: { serviceUrl: decoy.serviceUrl, health: decoy.healthStatus },
        };
      }
      return null;
    }
    case 'request_false_route_assignment': {
      const route = falseRoute.getRouteByOperation(operationKey);
      if (route) {
        return {
          resourceId: route.routeId,
          details: { assignedTarget: route.assignedTarget },
        };
      }
      return null;
    }
    case 'request_source_quarantine': {
      const quarantine = cloudArmor.getQuarantineByOperation(operationKey);
      if (quarantine) {
        return {
          resourceId: quarantine.ruleId,
          details: { priority: quarantine.rulePriority, policy: quarantine.policyName },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export async function dispatchProviderCall(
  toolCall: ToolCall,
  operationKey: string,
  cloudRun: FakeCloudRunAdapter,
  falseRoute: FakeFalseRouteAdapter,
  cloudArmor: FakeCloudArmorAdapter,
): Promise<ProviderExecutionResult> {
  switch (toolCall.toolName) {
    case 'request_decoy_deployment': {
      const params = toolCall.parameters as unknown as RequestDecoyDeploymentParams;
      const res = await cloudRun.deployDecoy({ ...params, operationKey });
      return {
        providerResourceId: res.serviceId,
        details: { serviceUrl: res.serviceUrl, health: res.healthStatus },
      };
    }
    case 'request_false_route_assignment': {
      const params = toolCall.parameters as unknown as RequestFalseRouteAssignmentParams;
      const res = await falseRoute.assignRoute({
        sourceIp: params.sourceIp,
        targetService: params.targetDecoyService,
        operationKey,
      });
      return {
        providerResourceId: res.routeId,
        details: { assignedTarget: res.assignedTarget },
      };
    }
    case 'request_source_quarantine': {
      const params = toolCall.parameters as unknown as RequestSourceQuarantineParams;
      const sourceCidr = `${params.sourceIp}/${params.cidrPrefix}`;
      const res = await cloudArmor.applyQuarantine({ sourceCidr, operationKey });
      return {
        providerResourceId: res.ruleId,
        details: { priority: res.rulePriority, policy: res.policyName },
      };
    }
    case 'request_operator_alert':
      return {
        details: {
          severity: toolCall.parameters['severity'],
          headline: toolCall.parameters['headline'],
        },
      };
    case 'recommend_response_plan':
      return {
        details: {
          recommendedActions: toolCall.parameters['recommendedActions'],
          confidence: toolCall.parameters['confidence'],
        },
      };
    default:
      return { details: {} };
  }
}

export async function ensureLeasePersisted(
  toolCall: ToolCall,
  workflowRepo: AutonomousWorkflowRepository,
  providerResourceId?: string | undefined,
  details?: Record<string, unknown> | undefined,
): Promise<void> {
  switch (toolCall.toolName) {
    case 'request_decoy_deployment': {
      const params = toolCall.parameters as unknown as RequestDecoyDeploymentParams;
      await workflowRepo.createDecoyLease({
        eventId: params.eventId,
        templateName: params.templateName,
        imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        desiredState: 'READY',
        observedState: 'READY',
        serviceUrl:
          (details?.['serviceUrl'] as string | undefined) ??
          `https://${providerResourceId ?? 'decoy'}.run.app.dummy`,
        healthStatus: (details?.['health'] as string | undefined) ?? 'HEALTHY',
        ttlSeconds: params.ttlSeconds,
      });
      break;
    }
    case 'request_false_route_assignment': {
      const params = toolCall.parameters as unknown as RequestFalseRouteAssignmentParams;
      await workflowRepo.createFalseRouteLease({
        eventId: params.eventId,
        sourceIp: params.sourceIp,
        assignedRoute: params.targetDecoyService,
        ttlSeconds: params.ttlSeconds,
      });
      break;
    }
    case 'request_source_quarantine': {
      const params = toolCall.parameters as unknown as RequestSourceQuarantineParams;
      const sourceCidr = `${params.sourceIp}/${params.cidrPrefix}`;
      await workflowRepo.createQuarantineLease({
        eventId: params.eventId,
        sourceCidr,
        rulePriority: (details?.['priority'] as number | undefined) ?? 1050,
        ttlSeconds: params.ttlSeconds,
      });
      break;
    }
  }
}

export async function handleExistingReservation(
  op: {
    stage: string;
    providerResourceId?: string | null | undefined;
    policyReason?: string | null | undefined;
    authorized: boolean;
  },
  toolCall: ToolCall,
  context: ToolExecutionContext,
  idempotencyKey: string,
  activityRepo: ActivityEventRepository,
): Promise<ToolResult> {
  if (op.stage === 'FAKE_EXECUTED') {
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      stage: 'FAKE_EXECUTED',
      idempotencyKey,
      authorized: true,
      policyReason: 'Idempotent replay: operation was previously executed',
      providerResourceId: op.providerResourceId ?? undefined,
      executedAt: new Date().toISOString(),
    };
  }
  if (op.stage === 'REJECTED') {
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      stage: 'REJECTED',
      idempotencyKey,
      authorized: false,
      policyReason: op.policyReason ?? 'Rejected by policy',
      executedAt: new Date().toISOString(),
    };
  }
  const reason = 'Provider outcome requires explicit reconciliation before retry';
  await activityRepo
    .recordActivityEvent({
      eventId: context.eventId,
      correlationId: context.correlationId,
      stage: 'FAILED',
      eventType: 'TOOL_FAILED',
      summary: `Encountered existing failed tool operation for ${toolCall.toolName}`,
      provenance: 'DERIVED',
      payload: { toolName: toolCall.toolName, error: reason },
    })
    .catch(() => {});

  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    stage: 'FAILED',
    idempotencyKey,
    authorized: op.authorized,
    policyReason: reason,
    executedAt: new Date().toISOString(),
  };
}

/**
 * Builds the explicit non-terminal outcome used whenever the provider effect is (or may be) real
 * but at least one mandatory durable projection is missing. The operation stays reconcilable.
 */
export function ambiguousToolResult(
  toolCall: ToolCall,
  idempotencyKey: string,
  policyReason: string,
  details: Record<string, unknown>,
  providerResourceId?: string | undefined,
): ToolResult {
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    stage: 'FAILED',
    idempotencyKey,
    authorized: true,
    policyReason,
    ...(providerResourceId !== undefined && { providerResourceId }),
    details: { ...details, reconciliationRequired: true },
    executedAt: new Date().toISOString(),
  };
}

export async function rejectToolCall(
  toolCall: ToolCall,
  context: ToolExecutionContext,
  idempotencyKey: string,
  input: Record<string, unknown>,
  reason: string,
  workflowRepo: AutonomousWorkflowRepository,
  activityRepo: ActivityEventRepository,
): Promise<ToolResult> {
  await workflowRepo.reserveToolOperation({
    idempotencyKey,
    eventId: context.eventId,
    toolName: toolCall.toolName,
    input,
    authorized: false,
    policyReason: reason,
    initialStage: 'REJECTED',
  });
  await activityRepo.recordActivityEvent({
    eventId: context.eventId,
    correlationId: context.correlationId,
    stage: 'REJECTED',
    eventType: 'TOOL_REJECTED',
    summary: `Deterministic policy rejected ${toolCall.toolName}: ${reason}`,
    provenance: 'DERIVED',
    payload: { toolName: toolCall.toolName, policyReason: reason },
  });
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    stage: 'REJECTED',
    idempotencyKey,
    authorized: false,
    policyReason: reason,
    executedAt: new Date().toISOString(),
  };
}

export async function failToolCall(
  toolCall: ToolCall,
  context: ToolExecutionContext,
  idempotencyKey: string,
  reason: string,
  workflowRepo: AutonomousWorkflowRepository,
  activityRepo: ActivityEventRepository,
): Promise<ToolResult> {
  await workflowRepo.updateToolOperationStage({
    idempotencyKey,
    stage: 'FAILED',
    observedState: 'UNKNOWN',
    // FAILED is a non-terminal, reconcilable stage, so a repeated failure must remain writable.
    expectedPriorStage: ['AUTHORIZED', 'FAILED'],
    details: { error: reason },
  });
  await activityRepo.recordActivityEvent({
    eventId: context.eventId,
    correlationId: context.correlationId,
    stage: 'FAILED',
    eventType: 'TOOL_FAILED',
    summary: `Simulated action execution failed for ${toolCall.toolName}`,
    provenance: 'DERIVED',
    payload: { toolName: toolCall.toolName, error: reason },
  });
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    stage: 'FAILED',
    idempotencyKey,
    authorized: true,
    policyReason: reason,
    executedAt: new Date().toISOString(),
  };
}

export async function releaseToolBudgets(
  toolBudgetKey: string,
  usdBudgetKey: string,
  estimatedCost: number,
  workerId: string,
  workflowRepo: AutonomousWorkflowRepository,
): Promise<void> {
  await workflowRepo
    .releaseBudget({ idempotencyKey: toolBudgetKey, ownerId: workerId })
    .catch(() => {});
  if (estimatedCost > 0) {
    await workflowRepo
      .releaseBudget({ idempotencyKey: usdBudgetKey, ownerId: workerId })
      .catch(() => {});
  }
}
