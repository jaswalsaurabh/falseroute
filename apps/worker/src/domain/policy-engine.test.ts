import { describe, expect, it } from 'vitest';
import {
  type IntrusionEvent,
  type ModelEnrichmentResult,
  type DegradedModelResult,
} from '@false-route/contracts';
import { evaluateDeceptionPolicy, ACTIVE_RULE_VERSION } from './policy-engine.js';

const mockDecoyEvent: IntrusionEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-decoy-001',
  sourceIp: '192.168.1.100',
  targetAsset: 'mock-admin-portal',
  eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
  failedLoginCount: 3,
  riskIndicators: ['SUSPICIOUS_USER_AGENT'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: true,
  decoyIdentifier: 'mock-admin-decoy-creds',
  status: 'PENDING',
  provenance: 'OBSERVED',
};

const mockNonDecoyEvent: IntrusionEvent = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-non-decoy-002',
  sourceIp: '10.0.0.50',
  targetAsset: 'mock-admin-portal',
  eventType: 'SUSPICIOUS_LOGIN',
  failedLoginCount: 1,
  riskIndicators: ['UNUSUAL_TIME'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: false,
  status: 'PENDING',
  provenance: 'OBSERVED',
};

describe('evaluateDeceptionPolicy', () => {
  it('deterministically assigns false route when approved decoy credential is used', () => {
    const decision = evaluateDeceptionPolicy({
      event: mockDecoyEvent,
      decisionId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    });

    expect(decision.action).toBe('ASSIGN_FALSE_ROUTE');
    if (decision.action === 'ASSIGN_FALSE_ROUTE') {
      expect(decision.assignedFalseRoute).toBe('mock-admin-decoy');
    }
    expect(decision.matchedPolicy).toBe('DECOY_CREDENTIAL_TRIGGER');
    expect(decision.containmentMode).toBe('SIMULATED');
    expect(decision.decisionProvenance).toBe('DERIVED');
    expect(decision.auditRecord.ruleVersion).toBe(ACTIVE_RULE_VERSION);
  });

  it('never assigns false route to a non-decoy event even if model recommends it', () => {
    const conflictingModelRecommendation: ModelEnrichmentResult = {
      correlationId: mockNonDecoyEvent.correlationId,
      confidence: 0.95,
      summary: 'Model hallucinates false route recommendation',
      explanation: 'Recommending false route redirection',
      provenance: 'INFERRED',
      modelIdentifier: 'gemini-test-model',
      evaluatedAt: '2026-08-22T00:00:02.000Z',
      recommendedAction: 'ASSIGN_FALSE_ROUTE',
      suggestedFalseRoute: 'mock-admin-decoy',
    };

    const decision = evaluateDeceptionPolicy({
      event: mockNonDecoyEvent,
      enrichment: conflictingModelRecommendation,
      decisionId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
    });

    expect(decision.action).not.toBe('ASSIGN_FALSE_ROUTE');
    expect(decision.action).toBe('OBSERVE');
    expect(decision.matchedPolicy).toBe('DEFAULT_OBSERVATION');
    expect('assignedFalseRoute' in decision).toBe(false);
    expect(decision.containmentMode).toBe('SIMULATED');
  });

  it('assigns ALERT_OPERATOR with HIGH_RISK_THRESHOLD policy when failed logins or risk indicators exceed threshold', () => {
    const highRiskEvent: IntrusionEvent = {
      ...mockNonDecoyEvent,
      failedLoginCount: 6,
      riskIndicators: ['CREDENTIAL_BURST'],
    };

    const decision = evaluateDeceptionPolicy({
      event: highRiskEvent,
      decisionId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a45',
    });

    expect(decision.action).toBe('ALERT_OPERATOR');
    expect(decision.matchedPolicy).toBe('HIGH_RISK_THRESHOLD');
    expect('assignedFalseRoute' in decision).toBe(false);
    expect(decision.containmentMode).toBe('SIMULATED');
  });

  it('preserves degraded model status without preventing deterministic safe decision', () => {
    const degradedResult: DegradedModelResult = {
      correlationId: mockDecoyEvent.correlationId,
      status: 'TIMEOUT',
      reason: 'Gemini upstream timed out after 5000ms',
      provenance: 'UNAVAILABLE',
      evaluatedAt: '2026-08-22T00:00:05.000Z',
    };

    const decision = evaluateDeceptionPolicy({
      event: mockDecoyEvent,
      enrichment: degradedResult,
      decisionId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
    });

    expect(decision.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(decision.modelEnrichment?.provenance).toBe('UNAVAILABLE');
  });

  it('rejects evaluation when enrichment correlationId does not match event correlationId', () => {
    const mismatchedEnrichment: DegradedModelResult = {
      correlationId: 'corr-mismatched-999',
      status: 'DEGRADED',
      reason: 'Corrupted payload',
      provenance: 'UNAVAILABLE',
      evaluatedAt: '2026-08-22T00:00:02.000Z',
    };

    expect(() =>
      evaluateDeceptionPolicy({
        event: mockDecoyEvent,
        enrichment: mismatchedEnrichment,
        decisionId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
      }),
    ).toThrow(/Correlation mismatch/);
  });
});
