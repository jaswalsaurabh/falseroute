import { describe, it, expect } from 'vitest';
import { evaluateAutonomousPolicy } from './autonomous-policy.js';
import {
  type IntrusionEventEnvelope,
  type AutonomousModelAnalysisResult,
  type AutonomousDegradedModelResult,
} from '@false-route/contracts';

function makePlanResult(
  id: string,
  actions: string[],
  eventId = '11111111-1111-4111-8111-111111111111',
): AutonomousModelAnalysisResult {
  return {
    status: 'SUCCESS',
    correlationId: id,
    modelIdentifier: 'gemini-2.5-flash',
    evaluatedAt: '2026-08-22T10:00:02.000Z',
    confidence: 0.95,
    summary: 'Plan test',
    toolRequests: [
      {
        toolCallId: `call-${id}`,
        toolName: 'recommend_response_plan',
        parameters: {
          eventId,
          recommendedActions: actions,
          rationale: 'Plan test',
          confidence: 0.95,
        },
        requestedAt: '2026-08-22T10:00:02.000Z',
      },
    ],
    provenance: 'INFERRED',
  };
}

describe('evaluateAutonomousPolicy', () => {
  const baseEnvProbeEnvelope: IntrusionEventEnvelope = {
    eventId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-policy-1',
    schemaVersion: '1.0.0',
    source: 'PUB_SUB',
    scenarioKind: 'ENV_FILE_PROBE',
    occurredAt: '2026-08-22T10:00:00.000Z',
    publishedAt: '2026-08-22T10:00:01.000Z',
    sourceIp: '198.51.100.25',
    evidence: {
      scenarioKind: 'ENV_FILE_PROBE',
      requestedPath: '/.env',
      httpMethod: 'GET',
      userAgent: 'not-a-real-scanner/1.0',
      sourceIp: '198.51.100.25',
      matchedString: '.env',
      isPositiveMatch: true,
    },
    provenance: 'OBSERVED',
  };

  it('authorizes canonical deployment, false route, and alert for valid positive ENV_FILE_PROBE when parameters match exactly', () => {
    const modelResult: AutonomousModelAnalysisResult = {
      status: 'SUCCESS',
      correlationId: 'corr-policy-1',
      modelIdentifier: 'gemini-2.5-flash',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      confidence: 0.95,
      summary: 'Probe targeting .env detected',
      toolRequests: [
        {
          toolCallId: 'call-plan',
          toolName: 'recommend_response_plan',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
            rationale: 'Deploy decoy for containment',
            confidence: 0.95,
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
        {
          toolCallId: 'call-1',
          toolName: 'request_decoy_deployment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Autonomous response for ENV_FILE_PROBE',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
        {
          toolCallId: 'call-2',
          toolName: 'request_false_route_assignment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            sourceIp: '198.51.100.25',
            targetDecoyService: 'mock-admin-decoy',
            ttlSeconds: 300,
            reason: 'Autonomous diversion for ENV_FILE_PROBE',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
        {
          toolCallId: 'call-3',
          toolName: 'request_operator_alert',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            severity: 'HIGH',
            headline: 'Incident Detected: .env Configuration Probe',
            details: 'Source 198.51.100.25 triggered POLICY_ENV_PROBE_CONTAINMENT',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
      provenance: 'INFERRED',
    };

    const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, modelResult);
    expect(evaluation.isPositiveMatch).toBe(true);
    expect(evaluation.isNegativeControl).toBe(false);
    expect(evaluation.canonicalActionsToExecute.length).toBe(3);
    expect(evaluation.canonicalActionPlans.length).toBe(3);
    expect(evaluation.canonicalActionPlans.every((p) => p.outcome === 'AUTHORIZED')).toBe(true);
    expect(evaluation.canonicalActionPlans.map((p) => p.origin)).toEqual([
      'MODEL_REQUEST',
      'MODEL_REQUEST',
      'MANDATORY_RULE',
    ]);
  });

  it('rejects all model requests and executes zero actions for negative control', () => {
    const negControlEnvelope: IntrusionEventEnvelope = {
      ...baseEnvProbeEnvelope,
      evidence: {
        ...baseEnvProbeEnvelope.evidence,
        isPositiveMatch: false,
        isNegativeControl: true,
      },
    };

    const modelResult: AutonomousModelAnalysisResult = {
      status: 'SUCCESS',
      correlationId: 'corr-policy-neg',
      modelIdentifier: 'gemini-2.5-flash',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      confidence: 0.9,
      summary: 'Adversary model proposing attack on negative control',
      toolRequests: [
        {
          toolCallId: 'call-malicious-1',
          toolName: 'request_decoy_deployment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Deploy decoy',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
      provenance: 'INFERRED',
    };

    const evaluation = evaluateAutonomousPolicy(negControlEnvelope, modelResult);
    expect(evaluation.isNegativeControl).toBe(true);
    expect(evaluation.isPositiveMatch).toBe(false);
    expect(evaluation.canonicalActionsToExecute.length).toBe(0);
    expect(evaluation.canonicalActionPlans.length).toBe(0);
    expect(evaluation.requestEvaluations.every((e) => e.outcome === 'REJECTED')).toBe(true);
  });

  describe('Table-driven parameter comparison for Fix 7 (NARROWED detection)', () => {
    const testCases = [
      {
        name: 'Deployment: wrong eventId produces NARROWED',
        toolName: 'request_decoy_deployment' as const,
        parameters: {
          eventId: '22222222-2222-4222-8222-222222222222',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Autonomous response for ENV_FILE_PROBE',
        },
        expectedOutcome: 'NARROWED' as const,
      },
      {
        name: 'Deployment: wrong TTL produces NARROWED',
        toolName: 'request_decoy_deployment' as const,
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 600, // catalog is 300
          reason: 'Autonomous response for ENV_FILE_PROBE',
        },
        expectedOutcome: 'NARROWED' as const,
      },
      {
        name: 'Routing: wrong TTL produces NARROWED',
        toolName: 'request_false_route_assignment' as const,
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          sourceIp: '198.51.100.25',
          targetDecoyService: 'mock-admin-decoy',
          ttlSeconds: 900, // catalog is 300
          reason: 'Autonomous diversion for ENV_FILE_PROBE',
        },
        expectedOutcome: 'NARROWED' as const,
      },
      {
        name: 'Alert: model-selected severity produces NARROWED',
        toolName: 'request_operator_alert' as const,
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          severity: 'INFO', // catalog expected is HIGH
          headline: 'Incident Detected: .env Configuration Probe',
          details: 'Source 198.51.100.25 triggered POLICY_ENV_PROBE_CONTAINMENT',
        },
        expectedOutcome: 'NARROWED' as const,
      },
    ];

    for (const tc of testCases) {
      it(tc.name, () => {
        const modelResult: AutonomousModelAnalysisResult = {
          status: 'SUCCESS',
          correlationId: 'corr-policy-narrow',
          modelIdentifier: 'gemini-2.5-flash',
          evaluatedAt: '2026-08-22T10:00:02.000Z',
          confidence: 0.95,
          summary: 'Analysis summary',
          toolRequests: [
            {
              toolCallId: 'call-plan',
              toolName: 'recommend_response_plan',
              parameters: {
                eventId: '11111111-1111-4111-8111-111111111111',
                recommendedActions: ['DEPLOY_DECOY'],
                rationale: 'Response plan',
                confidence: 0.95,
              },
              requestedAt: '2026-08-22T10:00:02.000Z',
            },
            {
              toolCallId: 'call-test',
              toolName: tc.toolName,
              parameters: tc.parameters,
              requestedAt: '2026-08-22T10:00:02.000Z',
            },
          ],
          provenance: 'INFERRED',
        };

        const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, modelResult);
        const reqEval = evaluation.requestEvaluations.find(
          (e) => e.requestedTool.toolName === tc.toolName,
        );
        expect(reqEval).toBeDefined();
        expect(reqEval?.outcome).toBe(tc.expectedOutcome);
      });
    }
  });

  it('rejects low-confidence model requests and uses only explicit degraded fallback actions', () => {
    const lowConfidenceResult: AutonomousModelAnalysisResult = {
      status: 'SUCCESS',
      correlationId: 'corr-policy-low',
      modelIdentifier: 'gemini-2.5-flash',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      confidence: 0.3,
      summary: 'Low confidence analysis',
      toolRequests: [
        {
          toolCallId: 'call-plan',
          toolName: 'recommend_response_plan',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['ALERT_OPERATOR'],
            rationale: 'Uncertain observation',
            confidence: 0.3,
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
      provenance: 'INFERRED',
    };

    const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, lowConfidenceResult);
    expect(evaluation.requestEvaluations[0]?.outcome).toBe('REJECTED');
    expect(evaluation.canonicalActionsToExecute.length).toBe(1);
    expect(evaluation.canonicalActionPlans[0]?.toolCall.toolName).toBe('request_operator_alert');
    expect(evaluation.canonicalActionPlans[0]?.origin).toBe('DEGRADED_FALLBACK');
    expect(evaluation.canonicalActionPlans.every((p) => p.outcome === 'AUTHORIZED')).toBe(true);
  });

  it('preserves fixed canonical action order even when Gemini requests route before deployment', () => {
    const reorderedModelResult: AutonomousModelAnalysisResult = {
      status: 'SUCCESS',
      correlationId: 'corr-policy-reorder',
      modelIdentifier: 'gemini-2.5-flash',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      confidence: 0.95,
      summary: 'Reordered request',
      toolRequests: [
        {
          toolCallId: 'call-plan',
          toolName: 'recommend_response_plan',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['ASSIGN_FALSE_ROUTE', 'DEPLOY_DECOY'],
            rationale: 'Reordered plan',
            confidence: 0.95,
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
        // Model requests route before deployment:
        {
          toolCallId: 'call-route',
          toolName: 'request_false_route_assignment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            sourceIp: '198.51.100.25',
            targetDecoyService: 'mock-admin-decoy',
            ttlSeconds: 300,
            reason: 'Autonomous diversion for ENV_FILE_PROBE',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
        {
          toolCallId: 'call-deploy',
          toolName: 'request_decoy_deployment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Autonomous response for ENV_FILE_PROBE',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
      provenance: 'INFERRED',
    };

    const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, reorderedModelResult);
    expect(evaluation.canonicalActionsToExecute.length).toBe(3);
    // Fixed order: Deploy FIRST, Route SECOND, Alert THIRD
    expect(evaluation.canonicalActionsToExecute[0]?.toolName).toBe('request_decoy_deployment');
    expect(evaluation.canonicalActionsToExecute[1]?.toolName).toBe(
      'request_false_route_assignment',
    );
    expect(evaluation.canonicalActionsToExecute[2]?.toolName).toBe('request_operator_alert');
    expect(evaluation.canonicalActionPlans[2]?.origin).toBe('MANDATORY_RULE');
  });

  it('guarantees mandatory mock-admin-decoy route for DECOY_CREDENTIAL_USE even if Gemini omits it', () => {
    const decoyCredEnvelope: IntrusionEventEnvelope = {
      ...baseEnvProbeEnvelope,
      scenarioKind: 'DECOY_CREDENTIAL_USE',
      evidence: {
        scenarioKind: 'DECOY_CREDENTIAL_USE',
        credentialType: 'AWS_ACCESS_KEY',
        canaryId: 'canary-mock-admin-1',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
      },
    };

    // Model only returns response plan and alert, omitting route assignment
    const modelOmissionResult: AutonomousModelAnalysisResult = {
      status: 'SUCCESS',
      correlationId: 'corr-policy-decoy',
      modelIdentifier: 'gemini-2.5-flash',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      confidence: 0.95,
      summary: 'Decoy credential analysis',
      toolRequests: [
        {
          toolCallId: 'call-plan',
          toolName: 'recommend_response_plan',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['ALERT_OPERATOR'],
            rationale: 'Alerting only',
            confidence: 0.95,
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
      provenance: 'INFERRED',
    };

    const evaluation = evaluateAutonomousPolicy(decoyCredEnvelope, modelOmissionResult);
    expect(evaluation.canonicalActionsToExecute.length).toBe(2);
    expect(evaluation.canonicalActionsToExecute[0]?.toolName).toBe(
      'request_false_route_assignment',
    );
    expect(evaluation.canonicalActionsToExecute[0]?.parameters['targetDecoyService']).toBe(
      'mock-admin-decoy',
    );
    expect(evaluation.canonicalActionPlans[0]?.origin).toBe('MANDATORY_RULE');
    expect(evaluation.canonicalActionPlans[0]?.outcome).toBe('AUTHORIZED');
  });

  it('authorizes complete fallback workflow when model is degraded', () => {
    const degradedResult: AutonomousDegradedModelResult = {
      status: 'UNAVAILABLE',
      correlationId: 'corr-policy-degraded',
      evaluatedAt: '2026-08-22T10:00:02.000Z',
      reason: 'Gemini service unavailable',
      provenance: 'UNAVAILABLE',
    };

    const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, degradedResult);
    expect(evaluation.modelDisposition).toBe('DEGRADED');
    expect(evaluation.canonicalActionsToExecute.length).toBe(1);
    expect(evaluation.canonicalActionPlans[0]?.origin).toBe('DEGRADED_FALLBACK');
    expect(evaluation.canonicalActionPlans.every((p) => p.outcome === 'AUTHORIZED')).toBe(true);
  });

  describe('recommend_response_plan policy evaluation', () => {
    it('evaluates recommend_response_plan as AUTHORIZED when actions match catalog', () => {
      const evaluation = evaluateAutonomousPolicy(
        baseEnvProbeEnvelope,
        makePlanResult('auth', ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR']),
      );
      const planEval = evaluation.requestEvaluations.find(
        (e) => e.requestedTool.toolName === 'recommend_response_plan',
      );
      expect(planEval?.outcome).toBe('AUTHORIZED');
      expect(planEval?.policyReason).toContain('Advisory response plan authorized');
    });

    it('evaluates recommend_response_plan as NARROWED when unauthorized actions are present', () => {
      const evaluation = evaluateAutonomousPolicy(
        baseEnvProbeEnvelope,
        makePlanResult('narrow', ['DEPLOY_DECOY', 'QUARANTINE_SOURCE']),
      );
      const planEval = evaluation.requestEvaluations.find(
        (e) => e.requestedTool.toolName === 'recommend_response_plan',
      );
      expect(planEval?.outcome).toBe('NARROWED');
      expect(planEval?.canonicalToolCall?.parameters['recommendedActions']).toEqual([
        'DEPLOY_DECOY',
      ]);
      expect(planEval?.policyReason).toContain('QUARANTINE_SOURCE');
    });

    it('evaluates recommend_response_plan as REJECTED when all recommended actions conflict', () => {
      const evaluation = evaluateAutonomousPolicy(
        baseEnvProbeEnvelope,
        makePlanResult('rej-actions', ['QUARANTINE_SOURCE']),
      );
      const planEval = evaluation.requestEvaluations.find(
        (e) => e.requestedTool.toolName === 'recommend_response_plan',
      );
      expect(planEval?.outcome).toBe('REJECTED');
      expect(planEval?.policyReason).toContain('conflict with allowed actions');
    });

    it('evaluates recommend_response_plan as REJECTED when eventId mismatches envelope', () => {
      const evaluation = evaluateAutonomousPolicy(
        baseEnvProbeEnvelope,
        makePlanResult(
          'rej-id',
          ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
          '22222222-2222-4222-8222-222222222222',
        ),
      );
      const planEval = evaluation.requestEvaluations.find(
        (e) => e.requestedTool.toolName === 'recommend_response_plan',
      );
      expect(planEval?.outcome).toBe('REJECTED');
      expect(planEval?.policyReason).toContain('does not match envelope eventId');
    });
  });

  it('does not add optional actions when a valid Gemini analysis omits them', () => {
    const evaluation = evaluateAutonomousPolicy(
      baseEnvProbeEnvelope,
      makePlanResult('optional-omitted', ['ALERT_OPERATOR']),
    );

    expect(evaluation.canonicalActionsToExecute).toHaveLength(1);
    expect(evaluation.canonicalActionPlans[0]?.toolCall.toolName).toBe('request_operator_alert');
    expect(evaluation.canonicalActionPlans[0]?.origin).toBe('MANDATORY_RULE');
  });

  it('rejects forbidden model actions while retaining mandatory policy actions', () => {
    const evaluation = evaluateAutonomousPolicy(baseEnvProbeEnvelope, {
      ...makePlanResult('forbidden', ['ALERT_OPERATOR']),
      toolRequests: [
        {
          toolCallId: 'call-forbidden-quarantine',
          toolName: 'request_source_quarantine',
          parameters: {
            eventId: baseEnvProbeEnvelope.eventId,
            sourceIp: baseEnvProbeEnvelope.sourceIp,
            cidrPrefix: 32,
            ttlSeconds: 300,
            reason: 'Attempted quarantine',
          },
          requestedAt: '2026-08-22T10:00:02.000Z',
        },
      ],
    });

    expect(evaluation.requestEvaluations[0]?.outcome).toBe('REJECTED');
    expect(evaluation.requestEvaluations[0]?.policyReason).toContain('forbidden');
    expect(evaluation.canonicalActionPlans.map((plan) => plan.toolCall.toolName)).toEqual([
      'request_operator_alert',
    ]);
    expect(evaluation.canonicalActionPlans[0]?.origin).toBe('MANDATORY_RULE');
  });
});
