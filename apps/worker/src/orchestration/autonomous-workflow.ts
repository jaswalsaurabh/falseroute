import {
  type IntrusionEventEnvelope,
  type ToolCall,
  IntrusionEventEnvelopeSchema,
  SCENARIO_CATALOG,
  validateScenarioEvidence,
} from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { ToolGateway } from '../tools/tool-gateway.js';

export interface AutonomousWorkflowResult {
  readonly status: 'COMPLETED' | 'DUPLICATE' | 'FAILED';
  readonly eventId: string;
  readonly correlationId: string;
  readonly executedActions: readonly string[];
  readonly acknowledged: boolean;
}

export class AutonomousWorkflowOrchestrator {
  private readonly toolGateway: ToolGateway;

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    toolGateway?: ToolGateway,
  ) {
    this.toolGateway = toolGateway ?? new ToolGateway(workflowRepo, activityRepo);
  }

  async processEventEnvelope(
    envelope: IntrusionEventEnvelope,
    transportId: string,
  ): Promise<AutonomousWorkflowResult> {
    const validatedEnvelope = IntrusionEventEnvelopeSchema.parse(envelope);
    const { eventId, correlationId, scenarioKind, sourceIp } = validatedEnvelope;
    const evidenceResult = validateScenarioEvidence(scenarioKind, validatedEnvelope.evidence);
    if (!evidenceResult.success) throw new Error(evidenceResult.error);
    const evidence = evidenceResult.data;
    const isPositiveMatch = evidence.isPositiveMatch;
    const isNegativeControl = evidence.isNegativeControl ?? false;

    // 1. Ingestion receipt and duplicate check
    const receiptResult = await this.workflowRepo.recordIngestionReceipt({
      eventId,
      transportId,
      source: validatedEnvelope.source,
      status: 'ACCEPTED',
    });

    if (receiptResult.isDuplicate) {
      await this.activityRepo.recordActivityEvent({
        eventId,
        correlationId,
        stage: 'COMPLETED',
        eventType: 'DUPLICATE_INGESTION_SKIPPED',
        summary: `Duplicate message ${transportId} received for event ${eventId}; skipped side-effect execution`,
        provenance: 'DERIVED',
      });

      return {
        status: 'DUPLICATE',
        eventId,
        correlationId,
        executedActions: [],
        acknowledged: true,
      };
    }

    // 2. Log initial RECEIVED stage
    await this.activityRepo.recordActivityEvent({
      eventId,
      correlationId,
      stage: 'RECEIVED',
      eventType: 'INTRUSION_INGESTED',
      summary: `Ingested ${scenarioKind} from ${sourceIp} via transport ${transportId}`,
      provenance: 'OBSERVED',
      payload: { scenarioKind, sourceIp, evidence },
    });

    // 3. Formulate bounded tool requests from preset & evidence
    const preset = SCENARIO_CATALOG[scenarioKind];
    const toolCalls: ToolCall[] = [];
    const executedActions: string[] = [];

    if (
      isPositiveMatch &&
      !isNegativeControl &&
      preset.allowedActions.includes('DEPLOY_DECOY') &&
      preset.decoyTemplate
    ) {
      toolCalls.push({
        toolCallId: `${eventId}-deploy`,
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId,
          templateName: preset.decoyTemplate,
          region: 'us-central1',
          ttlSeconds: preset.defaultTtlSeconds,
          reason: `Autonomous response for ${scenarioKind}`,
        },
        requestedAt: new Date().toISOString(),
      });
    }

    if (
      isPositiveMatch &&
      !isNegativeControl &&
      preset.allowedActions.includes('ASSIGN_FALSE_ROUTE')
    ) {
      toolCalls.push({
        toolCallId: `${eventId}-route`,
        toolName: 'request_false_route_assignment',
        parameters: {
          eventId,
          sourceIp,
          targetDecoyService: preset.decoyTemplate ?? 'mock-admin-decoy',
          ttlSeconds: preset.defaultTtlSeconds,
          reason: `Autonomous diversion for ${scenarioKind}`,
        },
        requestedAt: new Date().toISOString(),
      });
    }

    if (
      isPositiveMatch &&
      !isNegativeControl &&
      preset.allowedActions.includes('QUARANTINE_SOURCE')
    ) {
      toolCalls.push({
        toolCallId: `${eventId}-quarantine`,
        toolName: 'request_source_quarantine',
        parameters: {
          eventId,
          sourceIp,
          cidrPrefix: sourceIp.includes(':') ? 128 : 32,
          ttlSeconds: preset.defaultTtlSeconds,
          reason: `Autonomous quarantine for ${scenarioKind}`,
        },
        requestedAt: new Date().toISOString(),
      });
    }

    if (isPositiveMatch && !isNegativeControl && preset.allowedActions.includes('ALERT_OPERATOR')) {
      toolCalls.push({
        toolCallId: `${eventId}-alert`,
        toolName: 'request_operator_alert',
        parameters: {
          eventId,
          severity: preset.maxRiskScore > 90 ? 'CRITICAL' : 'HIGH',
          headline: `Incident Detected: ${preset.title}`,
          details: `Source ${sourceIp} triggered ${preset.expectedPolicy}`,
        },
        requestedAt: new Date().toISOString(),
      });
    }

    // 4. Execute tool calls through deterministic gateway
    for (const call of toolCalls) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.toolGateway.executeToolCall(call, {
        eventId,
        correlationId,
        scenarioKind,
        sourceIp,
        isPositiveMatch,
        isNegativeControl,
      });
      if (result.authorized) {
        executedActions.push(call.toolName);
      }
    }

    // 5. Finalize workflow
    await this.activityRepo.recordActivityEvent({
      eventId,
      correlationId,
      stage: 'COMPLETED',
      eventType: 'WORKFLOW_COMPLETED',
      summary: `Workflow completed for ${scenarioKind} with ${executedActions.length} authorized actions`,
      provenance: 'DERIVED',
      payload: { executedActions },
    });

    await this.workflowRepo.recordDeliveryAttempt({
      eventId,
      transportId,
      workerId: 'worker-autonomous-01',
      attemptNumber: 1,
      status: 'SUCCESS',
    });

    return {
      status: 'COMPLETED',
      eventId,
      correlationId,
      executedActions,
      acknowledged: true,
    };
  }
}
