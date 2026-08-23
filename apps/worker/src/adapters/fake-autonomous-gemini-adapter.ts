import {
  type IntrusionEventEnvelope,
  type AutonomousModelAnalysisResult,
  type AutonomousDegradedModelResult,
  type AutonomousToolCall,
  AutonomousModelAnalysisResultSchema,
  AutonomousDegradedModelResultSchema,
  SCENARIO_CATALOG,
  validateScenarioEvidence,
} from '@false-route/contracts';
import { type AutonomousGeminiAdapter } from './autonomous-gemini-adapter.js';

export type FakeAutonomousMode =
  | 'auto'
  | 'success'
  | 'timeout'
  | 'unavailable'
  | 'malformed-arguments'
  | 'unknown-tool'
  | 'repeated-requests'
  | 'excessive-requests'
  | 'conflicting-requests'
  | 'unsafe-resource-request'
  | 'low-confidence'
  | 'rate-limited'
  | 'server-error';

export interface FakeAutonomousAdapterOptions {
  readonly mode?: FakeAutonomousMode;
  readonly modelIdentifier?: string;
  readonly delayMs?: number;
  readonly transientFailuresBeforeSuccess?: number;
}

export class FakeAutonomousGeminiAdapter implements AutonomousGeminiAdapter {
  private mode: FakeAutonomousMode;
  private readonly modelIdentifier: string;
  private readonly delayMs: number;
  private transientFailuresRemaining: number;
  public callCount = 0;

  constructor(
    modeOrOptions: FakeAutonomousMode | FakeAutonomousAdapterOptions = 'auto',
    modelIdentifier = 'gemini-2.5-flash-fake',
  ) {
    if (typeof modeOrOptions === 'string') {
      this.mode = modeOrOptions;
      this.modelIdentifier = modelIdentifier;
      this.delayMs = 0;
      this.transientFailuresRemaining = 0;
    } else {
      this.mode = modeOrOptions.mode ?? 'auto';
      this.modelIdentifier = modeOrOptions.modelIdentifier ?? modelIdentifier;
      this.delayMs = modeOrOptions.delayMs ?? 0;
      this.transientFailuresRemaining = modeOrOptions.transientFailuresBeforeSuccess ?? 0;
    }
  }

  setMode(mode: FakeAutonomousMode): void {
    this.mode = mode;
  }

  setTransientFailuresRemaining(count: number): void {
    this.transientFailuresRemaining = count;
  }

  async analyzeEnvelope(
    envelope: IntrusionEventEnvelope,
    parentSignal?: AbortSignal,
  ): Promise<AutonomousModelAnalysisResult | AutonomousDegradedModelResult> {
    this.callCount++;

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (parentSignal?.aborted) {
          reject(parentSignal.reason ?? new Error('Aborted'));
          return;
        }
        const timer = setTimeout(resolve, this.delayMs);
        parentSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(parentSignal.reason ?? new Error('Aborted'));
          },
          { once: true },
        );
      });
    }

    const evaluatedAt = new Date().toISOString();

    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining--;
      return AutonomousDegradedModelResultSchema.parse({
        status: 'UNAVAILABLE',
        correlationId: envelope.correlationId,
        modelIdentifier: this.modelIdentifier,
        evaluatedAt,
        reason: 'Simulated transient upstream 503 error',
        provenance: 'UNAVAILABLE',
      });
    }

    switch (this.mode) {
      case 'timeout':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'TIMEOUT',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Simulated fake timeout after deadline',
          provenance: 'UNAVAILABLE',
        });

      case 'rate-limited':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'UNAVAILABLE',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Simulated rate limit quota exceeded (HTTP 429)',
          provenance: 'UNAVAILABLE',
        });

      case 'server-error':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'UNAVAILABLE',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Simulated internal server error (HTTP 503)',
          provenance: 'UNAVAILABLE',
        });

      case 'unavailable':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'UNAVAILABLE',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'AI analysis service unavailable or GEMINI_API_KEY not configured',
          provenance: 'UNAVAILABLE',
        });

      case 'malformed-arguments':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'INVALID_OUTPUT',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Simulated malformed parameter schema in model tool call',
          provenance: 'UNAVAILABLE',
        });

      case 'unknown-tool':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'INVALID_OUTPUT',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Simulated model request for undeclared tool name: execute_arbitrary_shell',
          provenance: 'UNAVAILABLE',
        });

      case 'excessive-requests':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'INVALID_OUTPUT',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Model exceeded maximum allowed tool requests count (5)',
          provenance: 'UNAVAILABLE',
        });

      case 'unsafe-resource-request':
        return AutonomousDegradedModelResultSchema.parse({
          status: 'INVALID_OUTPUT',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: 'Model returned schema-invalid tool request parameters',
          provenance: 'UNAVAILABLE',
        });

      case 'low-confidence':
        return AutonomousModelAnalysisResultSchema.parse({
          status: 'SUCCESS',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          confidence: 0.25,
          summary: 'Low confidence analysis recommendation',
          toolRequests: [
            {
              toolCallId: `call-low-1`,
              toolName: 'recommend_response_plan',
              parameters: {
                eventId: envelope.eventId,
                recommendedActions: ['ALERT_OPERATOR'],
                rationale: 'Uncertain observation with low confidence',
                confidence: 0.25,
              },
              requestedAt: evaluatedAt,
            },
          ],
          provenance: 'INFERRED',
        });

      case 'repeated-requests': {
        const { eventId } = envelope;
        const planCall: AutonomousToolCall = {
          toolCallId: `call-rep-plan`,
          toolName: 'recommend_response_plan',
          parameters: {
            eventId,
            recommendedActions: ['ALERT_OPERATOR'],
            rationale: 'Repeated alert plan',
            confidence: 0.88,
          },
          requestedAt: evaluatedAt,
        };
        const alertCall: AutonomousToolCall = {
          toolCallId: `call-rep-1`,
          toolName: 'request_operator_alert',
          parameters: {
            eventId,
            severity: 'HIGH',
            headline: 'Repeated alert headline',
            details: 'Repeated alert details',
          },
          requestedAt: evaluatedAt,
        };
        return AutonomousModelAnalysisResultSchema.parse({
          status: 'SUCCESS',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          confidence: 0.88,
          summary: 'Repeated tool requests generated',
          toolRequests: [planCall, alertCall, alertCall],
          provenance: 'INFERRED',
        });
      }

      case 'conflicting-requests': {
        const { eventId, sourceIp } = envelope;
        const planCall: AutonomousToolCall = {
          toolCallId: `call-conf-plan`,
          toolName: 'recommend_response_plan',
          parameters: {
            eventId,
            recommendedActions: ['ASSIGN_FALSE_ROUTE', 'QUARANTINE_SOURCE'],
            rationale: 'Conflicting plan',
            confidence: 0.9,
          },
          requestedAt: evaluatedAt,
        };
        return AutonomousModelAnalysisResultSchema.parse({
          status: 'SUCCESS',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          confidence: 0.9,
          summary: 'Conflicting containment actions proposed',
          toolRequests: [
            planCall,
            {
              toolCallId: `call-conf-1`,
              toolName: 'request_false_route_assignment',
              parameters: {
                eventId,
                sourceIp,
                targetDecoyService: 'mock-admin-decoy',
                ttlSeconds: 300,
                reason: 'Conflicting route assignment',
              },
              requestedAt: evaluatedAt,
            },
            {
              toolCallId: `call-conf-2`,
              toolName: 'request_source_quarantine',
              parameters: {
                eventId,
                sourceIp,
                cidrPrefix: 32,
                ttlSeconds: 300,
                reason: 'Conflicting quarantine assignment',
              },
              requestedAt: evaluatedAt,
            },
          ],
          provenance: 'INFERRED',
        });
      }

      case 'auto':
      case 'success': {
        const { eventId, scenarioKind, sourceIp } = envelope;
        const evidenceValidation = validateScenarioEvidence(scenarioKind, envelope.evidence);
        const evidence = evidenceValidation.success ? evidenceValidation.data : null;
        const isNegativeControl = evidence?.isNegativeControl ?? false;
        const isPositiveMatch = evidence?.isPositiveMatch ?? true;
        const preset = SCENARIO_CATALOG[scenarioKind];

        const toolRequests: AutonomousToolCall[] = [];

        // Negative control: model recommends observation or no containment actions
        if (isNegativeControl || !isPositiveMatch) {
          toolRequests.push({
            toolCallId: `call-${eventId.slice(0, 8)}-plan`,
            toolName: 'recommend_response_plan',
            parameters: {
              eventId,
              recommendedActions: ['NO_ACTION'],
              rationale: 'Legitimate or baseline traffic observed; no active containment needed',
              confidence: 0.95,
            },
            requestedAt: evaluatedAt,
          });

          return AutonomousModelAnalysisResultSchema.parse({
            status: 'SUCCESS',
            correlationId: envelope.correlationId,
            modelIdentifier: this.modelIdentifier,
            evaluatedAt,
            confidence: 0.95,
            summary: `Baseline evaluation for ${scenarioKind}: no containment needed`,
            toolRequests,
            provenance: 'INFERRED',
          });
        }

        // Positive scenarios: First include structured recommend_response_plan
        toolRequests.push({
          toolCallId: `call-${eventId.slice(0, 8)}-plan`,
          toolName: 'recommend_response_plan',
          parameters: {
            eventId,
            recommendedActions: preset.allowedActions,
            rationale: `Structured response plan for ${preset.title}`,
            confidence: 0.95,
          },
          requestedAt: evaluatedAt,
        });

        if (preset.allowedActions.includes('DEPLOY_DECOY') && preset.decoyTemplate) {
          toolRequests.push({
            toolCallId: `call-${eventId.slice(0, 8)}-deploy`,
            toolName: 'request_decoy_deployment',
            parameters: {
              eventId,
              templateName: preset.decoyTemplate as 'mock-admin-decoy' | 'mock-wordpress-decoy',
              region: 'us-central1',
              ttlSeconds: preset.defaultTtlSeconds,
              reason: `Autonomous response for ${scenarioKind}`,
            },
            requestedAt: evaluatedAt,
          });
        }

        if (preset.allowedActions.includes('ASSIGN_FALSE_ROUTE')) {
          toolRequests.push({
            toolCallId: `call-${eventId.slice(0, 8)}-route`,
            toolName: 'request_false_route_assignment',
            parameters: {
              eventId,
              sourceIp,
              targetDecoyService: preset.decoyTemplate ?? 'mock-admin-decoy',
              ttlSeconds: preset.defaultTtlSeconds,
              reason: `Autonomous diversion for ${scenarioKind}`,
            },
            requestedAt: evaluatedAt,
          });
        }

        if (preset.allowedActions.includes('QUARANTINE_SOURCE')) {
          toolRequests.push({
            toolCallId: `call-${eventId.slice(0, 8)}-quarantine`,
            toolName: 'request_source_quarantine',
            parameters: {
              eventId,
              sourceIp,
              cidrPrefix: sourceIp.includes(':') ? 128 : 32,
              ttlSeconds: preset.defaultTtlSeconds,
              reason: `Autonomous quarantine for ${scenarioKind}`,
            },
            requestedAt: evaluatedAt,
          });
        }

        if (preset.allowedActions.includes('ALERT_OPERATOR')) {
          toolRequests.push({
            toolCallId: `call-${eventId.slice(0, 8)}-alert`,
            toolName: 'request_operator_alert',
            parameters: {
              eventId,
              severity: preset.maxRiskScore > 90 ? 'CRITICAL' : 'HIGH',
              headline: `Incident Detected: ${preset.title}`,
              details: `Source ${sourceIp} triggered ${preset.expectedPolicy}`,
            },
            requestedAt: evaluatedAt,
          });
        }

        return AutonomousModelAnalysisResultSchema.parse({
          status: 'SUCCESS',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          confidence: 0.95,
          summary: `Autonomous security evaluation for ${preset.title}`,
          toolRequests: toolRequests.slice(0, 5),
          provenance: 'INFERRED',
        });
      }

      default: {
        const exhaustiveCheck: never = this.mode;
        return AutonomousDegradedModelResultSchema.parse({
          status: 'UNAVAILABLE',
          correlationId: envelope.correlationId,
          modelIdentifier: this.modelIdentifier,
          evaluatedAt,
          reason: `Unknown fake mode: ${String(exhaustiveCheck)}`,
          provenance: 'UNAVAILABLE',
        });
      }
    }
  }
}
