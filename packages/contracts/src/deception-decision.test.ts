import { describe, it, expect } from 'vitest';
import {
  DeceptionDecisionSchema,
  AssignFalseRouteDecisionSchema,
  AllowDecisionSchema,
  AlertOperatorDecisionSchema,
  ObserveDecisionSchema,
} from './deception-decision.js';

describe('Contracts — Deception Decision Discrimination & Correlation', () => {
  const baseDecision = {
    id: 'b1ffbc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    correlationId: 'corr-sim-12345',
    containmentMode: 'SIMULATED' as const,
    matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER' as const,
    reason: 'Deterministic match on known decoy credential in simulated mode.',
    decisionProvenance: 'DERIVED' as const,
    decidedAt: '2026-08-21T12:00:03.000Z',
    auditRecord: {
      ruleVersion: 'v1.0.0',
      evaluatedAt: '2026-08-21T12:00:03.000Z',
    },
  };

  const matchingEnrichment = {
    correlationId: 'corr-sim-12345',
    recommendedAction: 'ASSIGN_FALSE_ROUTE' as const,
    confidence: 0.9,
    summary: 'Matched decoy credential.',
    explanation: 'Simulated attacker probe detected.',
    suggestedFalseRoute: 'mock-admin-decoy' as const,
    provenance: 'INFERRED' as const,
    modelIdentifier: 'gemini-2.5-flash',
    evaluatedAt: '2026-08-21T12:00:02.000Z',
  };

  const mismatchedEnrichment = {
    correlationId: 'mismatched-event-corr-999',
    recommendedAction: 'ASSIGN_FALSE_ROUTE' as const,
    confidence: 0.9,
    summary: 'Matched decoy credential.',
    explanation: 'Simulated attacker probe detected.',
    suggestedFalseRoute: 'mock-admin-decoy' as const,
    provenance: 'INFERRED' as const,
    modelIdentifier: 'gemini-2.5-flash',
    evaluatedAt: '2026-08-21T12:00:02.000Z',
  };

  it('validates ASSIGN_FALSE_ROUTE decision with required false route', () => {
    const routeDecision = {
      ...baseDecision,
      action: 'ASSIGN_FALSE_ROUTE' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
    };

    const parsed = DeceptionDecisionSchema.parse(routeDecision);
    expect(parsed.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(parsed.assignedFalseRoute).toBe('mock-admin-decoy');

    const parsedDirect = AssignFalseRouteDecisionSchema.parse(routeDecision);
    expect(parsedDirect.assignedFalseRoute).toBe('mock-admin-decoy');
  });

  it('rejects ASSIGN_FALSE_ROUTE decision without assigned false route', () => {
    const routeDecisionMissingRoute = {
      ...baseDecision,
      action: 'ASSIGN_FALSE_ROUTE',
    };

    expect(() => DeceptionDecisionSchema.parse(routeDecisionMissingRoute)).toThrow();
    expect(() => AssignFalseRouteDecisionSchema.parse(routeDecisionMissingRoute)).toThrow();
  });

  it('rejects ASSIGN_FALSE_ROUTE decision with arbitrary route', () => {
    const routeDecisionArbitrary = {
      ...baseDecision,
      action: 'ASSIGN_FALSE_ROUTE',
      assignedFalseRoute: 'unauthorized-destination',
    };

    expect(() => DeceptionDecisionSchema.parse(routeDecisionArbitrary)).toThrow();
  });

  it('validates non-route decisions without assigned false route', () => {
    const nonRouteActions = ['ALLOW', 'ALERT_OPERATOR', 'OBSERVE'] as const;

    for (const action of nonRouteActions) {
      const decision = {
        ...baseDecision,
        action,
      };
      const parsed = DeceptionDecisionSchema.parse(decision);
      expect(parsed.action).toBe(action);
    }

    expect(AllowDecisionSchema.parse({ ...baseDecision, action: 'ALLOW' }).action).toBe('ALLOW');
    expect(
      AlertOperatorDecisionSchema.parse({
        ...baseDecision,
        action: 'ALERT_OPERATOR',
      }).action,
    ).toBe('ALERT_OPERATOR');
    expect(ObserveDecisionSchema.parse({ ...baseDecision, action: 'OBSERVE' }).action).toBe(
      'OBSERVE',
    );
  });

  it('rejects non-route decisions that include an assigned false route', () => {
    const nonRouteActions = ['ALLOW', 'ALERT_OPERATOR', 'OBSERVE'] as const;

    for (const action of nonRouteActions) {
      const contradictoryDecision = {
        ...baseDecision,
        action,
        assignedFalseRoute: 'mock-admin-decoy',
      };
      expect(() => DeceptionDecisionSchema.parse(contradictoryDecision)).toThrow();
    }
  });

  it('validates decision with matching modelEnrichment correlationId', () => {
    const decisionWithEnrichment = {
      ...baseDecision,
      action: 'ASSIGN_FALSE_ROUTE' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
      modelEnrichment: matchingEnrichment,
    };

    const parsed = DeceptionDecisionSchema.parse(decisionWithEnrichment);
    expect(parsed.modelEnrichment?.correlationId).toBe(baseDecision.correlationId);

    const parsedVariant = AssignFalseRouteDecisionSchema.parse(decisionWithEnrichment);
    expect(parsedVariant.modelEnrichment?.correlationId).toBe(baseDecision.correlationId);
  });

  it('rejects decision when modelEnrichment belongs to a different correlationId on both union and variant schemas', () => {
    const mismatchedDecision = {
      ...baseDecision,
      action: 'ASSIGN_FALSE_ROUTE' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
      modelEnrichment: mismatchedEnrichment,
    };

    expect(() => DeceptionDecisionSchema.parse(mismatchedDecision)).toThrow();
    expect(() => AssignFalseRouteDecisionSchema.parse(mismatchedDecision)).toThrow();

    const mismatchedAllow = {
      ...baseDecision,
      action: 'ALLOW' as const,
      modelEnrichment: mismatchedEnrichment,
    };
    expect(() => AllowDecisionSchema.parse(mismatchedAllow)).toThrow();

    const mismatchedAlert = {
      ...baseDecision,
      action: 'ALERT_OPERATOR' as const,
      modelEnrichment: mismatchedEnrichment,
    };
    expect(() => AlertOperatorDecisionSchema.parse(mismatchedAlert)).toThrow();

    const mismatchedObserve = {
      ...baseDecision,
      action: 'OBSERVE' as const,
      modelEnrichment: mismatchedEnrichment,
    };
    expect(() => ObserveDecisionSchema.parse(mismatchedObserve)).toThrow();
  });
});
