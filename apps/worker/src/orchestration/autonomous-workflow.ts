import {
  type IntrusionEventEnvelope,
  IntrusionEventEnvelopeSchema,
  validateScenarioEvidence,
} from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { ToolGateway } from '../tools/tool-gateway.js';
import { type AutonomousGeminiAdapter } from '../adapters/autonomous-gemini-adapter.js';
import { FakeAutonomousGeminiAdapter } from '../adapters/fake-autonomous-gemini-adapter.js';
import { evaluateAutonomousPolicy } from '../domain/autonomous-policy.js';

export interface AutonomousWorkflowResult {
  readonly status: 'COMPLETED' | 'DUPLICATE' | 'FAILED';
  readonly eventId: string;
  readonly correlationId: string;
  readonly executedActions: readonly string[];
  readonly acknowledged: boolean;
}

export class AutonomousWorkflowOrchestrator {
  private readonly toolGateway: ToolGateway;
  private readonly geminiAdapter: AutonomousGeminiAdapter;

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    toolGateway?: ToolGateway,
    geminiAdapter?: AutonomousGeminiAdapter,
  ) {
    this.toolGateway = toolGateway ?? new ToolGateway(workflowRepo, activityRepo);
    this.geminiAdapter = geminiAdapter ?? new FakeAutonomousGeminiAdapter('unavailable');
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
      payload: { scenarioKind, sourceIp },
    });

    // 3. Emit GEMINI_ANALYSIS_REQUESTED activity event
    await this.activityRepo.recordActivityEvent({
      eventId,
      correlationId,
      stage: 'RECEIVED',
      eventType: 'GEMINI_ANALYSIS_REQUESTED',
      summary: `Initiating bounded Gemini analysis for ${scenarioKind}`,
      provenance: 'OBSERVED',
      payload: { scenarioKind, sourceIp },
    });

    // 4. Bounded Gemini analysis
    const modelResult = await this.geminiAdapter.analyzeEnvelope(validatedEnvelope);

    if (modelResult.status === 'SUCCESS') {
      await this.activityRepo.recordActivityEvent({
        eventId,
        correlationId,
        stage: 'ENRICHED',
        eventType: 'GEMINI_ANALYSIS_COMPLETED',
        summary: `Gemini analysis completed (${modelResult.confidence.toFixed(2)} confidence): ${modelResult.summary}`,
        provenance: 'INFERRED',
        payload: {
          confidence: modelResult.confidence,
          modelIdentifier: modelResult.modelIdentifier,
          requestedToolsCount: modelResult.toolRequests.length,
        },
      });

      // Record each requested tool as safe metadata only (no raw model free-form parameter blobs)
      let requestIdx = 0;
      for (const req of modelResult.toolRequests) {
        requestIdx++;
        // eslint-disable-next-line no-await-in-loop
        await this.activityRepo.recordActivityEvent({
          eventId,
          correlationId,
          stage: 'REQUESTED',
          eventType: 'MODEL_TOOL_REQUESTED',
          summary: `Model requested tool: ${req.toolName}`,
          provenance: 'INFERRED',
          payload: {
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            requestIndex: requestIdx,
            totalRequests: modelResult.toolRequests.length,
          },
        });
      }
    } else {
      await this.activityRepo.recordActivityEvent({
        eventId,
        correlationId,
        stage: 'ENRICHED',
        eventType: 'GEMINI_ANALYSIS_DEGRADED',
        summary: `Gemini analysis degraded (${modelResult.status}): ${modelResult.reason}`,
        provenance: 'UNAVAILABLE',
        payload: {
          status: modelResult.status,
          reason: modelResult.reason,
        },
      });
    }

    // 5. Evaluate deterministic policy against model output and authoritative catalog
    const policyEval = evaluateAutonomousPolicy(validatedEnvelope, modelResult);

    // Record policy outcomes for model requests (rejections + recommend_response_plan decisions)
    for (const evalResult of policyEval.requestEvaluations) {
      if (evalResult.outcome === 'REJECTED') {
        // eslint-disable-next-line no-await-in-loop
        await this.activityRepo.recordActivityEvent({
          eventId,
          correlationId,
          stage: 'REJECTED',
          eventType: 'TOOL_REJECTED',
          summary: `Deterministic policy rejected ${evalResult.requestedTool.toolName}: ${evalResult.policyReason}`,
          provenance: 'DERIVED',
          payload: {
            toolName: evalResult.requestedTool.toolName,
            outcome: 'REJECTED',
            policyReason: evalResult.policyReason,
          },
        });
      } else if (evalResult.requestedTool.toolName === 'recommend_response_plan') {
        const eventType = evalResult.outcome === 'AUTHORIZED' ? 'TOOL_AUTHORIZED' : 'TOOL_NARROWED';
        // eslint-disable-next-line no-await-in-loop
        await this.activityRepo.recordActivityEvent({
          eventId,
          correlationId,
          stage: evalResult.outcome,
          eventType,
          summary: `Deterministic policy ${evalResult.outcome.toLowerCase()} recommend_response_plan: ${evalResult.policyReason}`,
          provenance: 'DERIVED',
          payload: {
            toolName: 'recommend_response_plan',
            outcome: evalResult.outcome,
            policyReason: evalResult.policyReason,
          },
        });
      }
    }

    // Record policy authorization/narrowing for all planned canonical actions before execution
    for (const plan of policyEval.canonicalActionPlans) {
      const eventType = plan.outcome === 'AUTHORIZED' ? 'TOOL_AUTHORIZED' : 'TOOL_NARROWED';
      // eslint-disable-next-line no-await-in-loop
      await this.activityRepo.recordActivityEvent({
        eventId,
        correlationId,
        stage: plan.outcome,
        eventType,
        summary: `Deterministic policy ${plan.outcome.toLowerCase()} ${plan.toolCall.toolName}: ${plan.policyReason}`,
        provenance: 'DERIVED',
        payload: {
          toolName: plan.toolCall.toolName,
          outcome: plan.outcome,
          policyReason: plan.policyReason,
          origin: plan.origin,
        },
      });
    }

    // 6. Execute authorized canonical tool actions through deterministic gateway
    let hasFailure = false;
    const executedActions: string[] = [];
    const failedActions: string[] = [];

    for (const call of policyEval.canonicalActionsToExecute) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.toolGateway.executeToolCall(call, {
        eventId,
        correlationId,
        scenarioKind,
        sourceIp,
        isPositiveMatch,
        isNegativeControl,
      });

      if (result.stage === 'FAKE_EXECUTED') {
        executedActions.push(call.toolName);
      } else {
        hasFailure = true;
        failedActions.push(call.toolName);
        break;
      }
    }

    // 7. Finalize workflow
    if (hasFailure) {
      await this.activityRepo.recordActivityEvent({
        eventId,
        correlationId,
        stage: 'FAILED',
        eventType: 'WORKFLOW_FAILED',
        summary: `Workflow execution failed for ${scenarioKind}: one or more required actions failed or were rejected`,
        provenance: 'DERIVED',
        payload: {
          scenarioKind,
          executedActions,
          failedActions,
          modelDisposition: policyEval.modelDisposition,
        },
      });

      await this.workflowRepo.recordDeliveryAttempt({
        eventId,
        transportId,
        workerId: 'worker-autonomous-01',
        attemptNumber: 1,
        status: 'TERMINAL_FAILURE',
      });

      return {
        status: 'FAILED',
        eventId,
        correlationId,
        executedActions,
        acknowledged: true,
      };
    }

    await this.activityRepo.recordActivityEvent({
      eventId,
      correlationId,
      stage: 'COMPLETED',
      eventType: 'WORKFLOW_COMPLETED',
      summary: `Workflow completed for ${scenarioKind} with ${executedActions.length} simulated actions executed`,
      provenance: 'DERIVED',
      payload: {
        executedActions,
        modelDisposition: policyEval.modelDisposition,
      },
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
