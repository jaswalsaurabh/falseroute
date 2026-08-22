import {
  type ToolCall,
  type ToolResult,
  type ScenarioKind,
  type RequestDecoyDeploymentParams,
  type RequestFalseRouteAssignmentParams,
  type RequestSourceQuarantineParams,
  RecommendResponsePlanParamsSchema,
  RequestDecoyDeploymentParamsSchema,
  RequestFalseRouteAssignmentParamsSchema,
  RequestSourceQuarantineParamsSchema,
  RequestOperatorAlertParamsSchema,
} from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  FakeCloudRunAdapter,
  FakeFalseRouteAdapter,
  FakeCloudArmorAdapter,
} from './fake-cloud-adapters.js';

export interface ToolGatewayOptions {
  readonly cloudRunAdapter?: FakeCloudRunAdapter;
  readonly falseRouteAdapter?: FakeFalseRouteAdapter;
  readonly cloudArmorAdapter?: FakeCloudArmorAdapter;
  readonly maxHourlyToolCeiling?: number;
  readonly workerId?: string;
}

export interface ToolExecutionContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly scenarioKind: ScenarioKind;
  readonly sourceIp: string;
  readonly isPositiveMatch: boolean;
  readonly isNegativeControl: boolean;
}

export class ToolGateway {
  private readonly cloudRun: FakeCloudRunAdapter;
  private readonly falseRoute: FakeFalseRouteAdapter;
  private readonly cloudArmor: FakeCloudArmorAdapter;
  private readonly maxHourlyCeiling: number;
  private hourlyExecutionCount = 0;
  private lastCeilingReset = Date.now();
  private readonly workerId: string;

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    options: ToolGatewayOptions = {},
  ) {
    this.cloudRun = options.cloudRunAdapter ?? new FakeCloudRunAdapter();
    this.falseRoute = options.falseRouteAdapter ?? new FakeFalseRouteAdapter();
    this.cloudArmor = options.cloudArmorAdapter ?? new FakeCloudArmorAdapter();
    this.maxHourlyCeiling = options.maxHourlyToolCeiling ?? 50;
    this.workerId = options.workerId ?? 'worker-autonomous-01';
  }

  async executeToolCall(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const idempotencyKey = `idem-${toolCall.toolName}-${context.eventId}`;
    const input = toolCall.parameters;

    // 0. Hourly Spend & Safety Ceiling Check
    this.checkAndResetHourlyCeiling();
    if (this.hourlyExecutionCount >= this.maxHourlyCeiling) {
      const reason = `Hourly safety spend ceiling reached (${this.maxHourlyCeiling} operations/hour)`;
      await this.workflowRepo.reserveToolOperation({
        idempotencyKey,
        eventId: context.eventId,
        toolName: toolCall.toolName,
        input,
        authorized: false,
        policyReason: reason,
        initialStage: 'REJECTED',
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

    // 1. Validate tool parameters against contract schema
    const validation = this.validateParameters(toolCall, context);
    if (!validation.success) {
      await this.workflowRepo.reserveToolOperation({
        idempotencyKey,
        eventId: context.eventId,
        toolName: toolCall.toolName,
        input,
        authorized: false,
        policyReason: `Parameter validation failed: ${validation.error}`,
        initialStage: 'REJECTED',
      });

      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'REJECTED',
        idempotencyKey,
        authorized: false,
        policyReason: validation.error,
        executedAt: new Date().toISOString(),
      };
    }

    // 2. Evaluate deterministic application policy (including negative control rejection)
    const policyDecision = this.evaluatePolicy(toolCall.toolName, context);
    if (!policyDecision.authorized) {
      await this.workflowRepo.reserveToolOperation({
        idempotencyKey,
        eventId: context.eventId,
        toolName: toolCall.toolName,
        input,
        authorized: false,
        policyReason: policyDecision.reason,
        initialStage: 'REJECTED',
      });

      await this.activityRepo.recordActivityEvent({
        eventId: context.eventId,
        correlationId: context.correlationId,
        stage: 'REJECTED',
        eventType: 'TOOL_REJECTED',
        summary: `Deterministic policy rejected ${toolCall.toolName}: ${policyDecision.reason}`,
        provenance: 'DERIVED',
      });

      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'REJECTED',
        idempotencyKey,
        authorized: false,
        policyReason: policyDecision.reason,
        executedAt: new Date().toISOString(),
      };
    }

    // 3. Reserve tool operation in ledger (idempotency check)
    const reservation = await this.workflowRepo.reserveToolOperation({
      idempotencyKey,
      eventId: context.eventId,
      toolName: toolCall.toolName,
      input,
      authorized: true,
      policyReason: policyDecision.reason,
      initialStage: 'AUTHORIZED',
    });

    if (reservation.isExisting && reservation.operation.stage === 'FAKE_EXECUTED') {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'FAKE_EXECUTED',
        idempotencyKey,
        authorized: true,
        policyReason: 'Idempotent replay: operation was previously executed',
        providerResourceId: reservation.operation.providerResourceId ?? undefined,
        executedAt: new Date().toISOString(),
      };
    }

    if (reservation.isExisting && reservation.operation.stage === 'REJECTED') {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'REJECTED',
        idempotencyKey,
        authorized: false,
        policyReason: reservation.operation.policyReason,
        executedAt: new Date().toISOString(),
      };
    }

    if (reservation.isExisting && reservation.operation.stage === 'FAILED') {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'FAILED',
        idempotencyKey,
        authorized: reservation.operation.authorized,
        policyReason: 'Provider outcome requires explicit reconciliation before retry',
        executedAt: new Date().toISOString(),
      };
    }

    // 4. Create Provider Intent record prior to executing side effect
    const providerName = this.resolveProviderName(toolCall.toolName);
    const intentClaim = await this.workflowRepo.claimProviderIntent({
      idempotencyKey,
      eventId: context.eventId,
      operationType: toolCall.toolName,
      provider: providerName,
      claimOwner: this.workerId,
      payload: toolCall.parameters,
    });

    if (intentClaim.disposition === 'ALREADY_EXECUTED') {
      const priorResult =
        intentClaim.intent.result && typeof intentClaim.intent.result === 'object'
          ? (intentClaim.intent.result as Record<string, unknown>)
          : {};
      const priorResourceId =
        typeof priorResult['providerResourceId'] === 'string'
          ? priorResult['providerResourceId']
          : undefined;
      await this.workflowRepo.updateToolOperationStage({
        idempotencyKey,
        stage: 'FAKE_EXECUTED',
        expectedPriorStage: 'AUTHORIZED',
        observedState: 'READY',
        ...(priorResourceId && { providerResourceId: priorResourceId }),
        details: priorResult,
      });
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'FAKE_EXECUTED',
        idempotencyKey,
        authorized: true,
        policyReason: 'Recovered the durable result without repeating the provider call',
        ...(priorResourceId && { providerResourceId: priorResourceId }),
        details: priorResult,
        executedAt: new Date().toISOString(),
      };
    }

    if (intentClaim.disposition === 'RECONCILIATION_REQUIRED' || !intentClaim.claimToken) {
      await this.workflowRepo.updateToolOperationStage({
        idempotencyKey,
        stage: 'FAILED',
        expectedPriorStage: 'AUTHORIZED',
        observedState: 'UNKNOWN',
        details: { recovery: 'RECONCILIATION_REQUIRED' },
      });
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        stage: 'FAILED',
        idempotencyKey,
        authorized: true,
        policyReason: 'Provider outcome is uncertain; reconciliation is required before retry',
        executedAt: new Date().toISOString(),
      };
    }
    const claimToken = intentClaim.claimToken;

    // 5. Execute side effect via provider-neutral adapters with intent tracking
    let providerResourceId: string | undefined;
    let details: Record<string, unknown> | undefined;

    try {
      switch (toolCall.toolName) {
        case 'request_decoy_deployment': {
          const params = toolCall.parameters as unknown as RequestDecoyDeploymentParams;
          const result = await this.cloudRun.deployDecoy(params);
          providerResourceId = result.serviceId;
          details = { serviceUrl: result.serviceUrl, health: result.healthStatus };

          await this.workflowRepo.createDecoyLease({
            eventId: params.eventId,
            templateName: params.templateName,
            imageDigest: 'sha256:dummy-allowlisted-digest-001',
            desiredState: 'READY',
            observedState: 'READY',
            serviceUrl: result.serviceUrl,
            healthStatus: result.healthStatus,
            ttlSeconds: params.ttlSeconds,
          });
          break;
        }

        case 'request_false_route_assignment': {
          const params = toolCall.parameters as unknown as RequestFalseRouteAssignmentParams;
          const result = await this.falseRoute.assignRoute({
            sourceIp: params.sourceIp,
            targetService: params.targetDecoyService,
          });
          providerResourceId = result.routeId;
          details = { assignedTarget: result.assignedTarget };

          await this.workflowRepo.createFalseRouteLease({
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
          const result = await this.cloudArmor.applyQuarantine({ sourceCidr });
          providerResourceId = result.ruleId;
          details = { priority: result.rulePriority, policy: result.policyName };

          await this.workflowRepo.createQuarantineLease({
            eventId: params.eventId,
            sourceCidr,
            rulePriority: result.rulePriority,
            ttlSeconds: params.ttlSeconds,
          });
          break;
        }

        case 'request_operator_alert':
        case 'recommend_response_plan':
          details = toolCall.parameters;
          break;
      }

      // Mark provider intent EXECUTED
      await this.workflowRepo.updateProviderIntentStatus({
        idempotencyKey,
        claimToken,
        status: 'EXECUTED',
        result: { ...details, ...(providerResourceId && { providerResourceId }) },
      });
      this.hourlyExecutionCount += 1;
    } catch (err) {
      // Mark provider intent FAILED on exception
      await this.workflowRepo.updateProviderIntentStatus({
        idempotencyKey,
        claimToken,
        status: 'FAILED',
        result: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }

    // 6. Update ledger to FAKE_EXECUTED with CAS prior-stage check
    await this.workflowRepo.updateToolOperationStage({
      idempotencyKey,
      stage: 'FAKE_EXECUTED',
      observedState: 'READY',
      expectedPriorStage: 'AUTHORIZED',
      ...(providerResourceId !== undefined && { providerResourceId }),
      ...(details !== undefined && { details }),
    });

    await this.activityRepo.recordActivityEvent({
      eventId: context.eventId,
      correlationId: context.correlationId,
      stage: 'FAKE_EXECUTED',
      eventType: 'TOOL_EXECUTED',
      summary: `Simulated action executed for ${toolCall.toolName}`,
      provenance: 'DERIVED',
      payload: details,
    });

    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      stage: 'FAKE_EXECUTED',
      idempotencyKey,
      authorized: true,
      policyReason: policyDecision.reason,
      providerResourceId,
      details,
      executedAt: new Date().toISOString(),
    };
  }

  private resolveProviderName(toolName: string): string {
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

  private checkAndResetHourlyCeiling(): void {
    const now = Date.now();
    if (now - this.lastCeilingReset > 3600000) {
      this.hourlyExecutionCount = 0;
      this.lastCeilingReset = now;
    }
  }

  private validateParameters(
    toolCall: ToolCall,
    context: ToolExecutionContext,
  ): { success: true } | { success: false; error: string } {
    try {
      switch (toolCall.toolName) {
        case 'recommend_response_plan':
          RecommendResponsePlanParamsSchema.parse(toolCall.parameters);
          break;
        case 'request_decoy_deployment':
          RequestDecoyDeploymentParamsSchema.parse(toolCall.parameters);
          break;
        case 'request_false_route_assignment':
          RequestFalseRouteAssignmentParamsSchema.parse(toolCall.parameters);
          break;
        case 'request_source_quarantine':
          RequestSourceQuarantineParamsSchema.parse(toolCall.parameters);
          break;
        case 'request_operator_alert':
          RequestOperatorAlertParamsSchema.parse(toolCall.parameters);
          break;
      }
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

  private evaluatePolicy(
    toolName: string,
    context: ToolExecutionContext,
  ): { authorized: boolean; reason: string } {
    // Negative-control rejection: negative control markers or non-positive match evidence must not execute deception
    if (context.isNegativeControl || !context.isPositiveMatch) {
      return {
        authorized: false,
        reason:
          'Negative control evidence rejected: no containment or deception authorized for baseline traffic',
      };
    }

    // Mandatory deterministic rule: Decoy credential use must always assign false route to mock-admin-decoy
    if (context.scenarioKind === 'DECOY_CREDENTIAL_USE') {
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
      context.scenarioKind === 'ENV_FILE_PROBE' ||
      context.scenarioKind === 'WORDPRESS_CONFIG_PROBE' ||
      context.scenarioKind === 'PATH_TRAVERSAL_PROBE'
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
      context.scenarioKind === 'SUSPICIOUS_IP_BURST' ||
      context.scenarioKind === 'SIP_INVITE_FLOOD' ||
      context.scenarioKind === 'TOKEN_TAMPER'
    ) {
      if (
        toolName === 'request_decoy_deployment' ||
        toolName === 'request_false_route_assignment'
      ) {
        return {
          authorized: false,
          reason: 'Volumetric and token tamper incidents require quarantine, not web decoy',
        };
      }
      return { authorized: true, reason: 'Deterministic quarantine policy authorized' };
    }

    return { authorized: true, reason: 'General policy evaluation passed' };
  }
}
