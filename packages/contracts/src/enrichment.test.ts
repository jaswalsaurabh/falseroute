import { describe, it, expect } from 'vitest';
import { ModelEnrichmentResultSchema, DegradedModelResultSchema } from './enrichment.js';
import { DeceptionActionSchema } from './primitives.js';

describe('Contracts — Model Enrichment & Bounded Output', () => {
  const baseEnrichment = {
    correlationId: 'corr-sim-12345',
    confidence: 0.95,
    summary: 'Decoy credential match indicates targeted simulated probe.',
    explanation: 'The source IP attempted login with a designated administrative decoy credential.',
    provenance: 'INFERRED' as const,
    modelIdentifier: 'gemini-2.5-flash',
    evaluatedAt: '2026-08-21T12:00:02.000Z',
  };

  it('validates ASSIGN_FALSE_ROUTE recommendation with required allowlisted false route', () => {
    const routeEnrichment = {
      ...baseEnrichment,
      recommendedAction: 'ASSIGN_FALSE_ROUTE' as const,
      suggestedFalseRoute: 'mock-admin-decoy' as const,
    };

    const parsed = ModelEnrichmentResultSchema.parse(routeEnrichment);
    expect(parsed).toEqual(routeEnrichment);
  });

  it('rejects ASSIGN_FALSE_ROUTE recommendation missing suggestedFalseRoute', () => {
    const missingRouteEnrichment = {
      ...baseEnrichment,
      recommendedAction: 'ASSIGN_FALSE_ROUTE' as const,
    };

    expect(() => ModelEnrichmentResultSchema.parse(missingRouteEnrichment)).toThrow();
  });

  it('validates non-route recommendations without suggested false route', () => {
    const nonRouteActions = ['ALLOW', 'ALERT_OPERATOR', 'OBSERVE'] as const;

    for (const action of nonRouteActions) {
      const nonRouteEnrichment = {
        ...baseEnrichment,
        recommendedAction: action,
      };
      const parsed = ModelEnrichmentResultSchema.parse(nonRouteEnrichment);
      expect(parsed.recommendedAction).toBe(action);
    }
  });

  it('rejects non-route recommendations that include a suggested false route', () => {
    const nonRouteActions = ['ALLOW', 'ALERT_OPERATOR', 'OBSERVE'] as const;

    for (const action of nonRouteActions) {
      const contradictoryEnrichment = {
        ...baseEnrichment,
        recommendedAction: action,
        suggestedFalseRoute: 'mock-admin-decoy',
      };
      expect(() => ModelEnrichmentResultSchema.parse(contradictoryEnrichment)).toThrow();
    }
  });

  it('rejects arbitrary false route destinations proposed by the model', () => {
    const arbitraryRoutes = [
      'https://attacker-c2.com/payload',
      'internal-database-cluster',
      '/etc/shadow',
      'mock-admin-decoy-v2-arbitrary',
    ];

    for (const route of arbitraryRoutes) {
      expect(() =>
        ModelEnrichmentResultSchema.parse({
          ...baseEnrichment,
          recommendedAction: 'ASSIGN_FALSE_ROUTE',
          suggestedFalseRoute: route,
        }),
      ).toThrow();
    }
  });

  it('rejects arbitrary or unsafe model actions outside the allowlist', () => {
    const unauthorizedActions = [
      'EXECUTE_SHELL_COMMAND',
      'REDIRECT_TRAFFIC_TO_EXTERNAL_URL',
      'DROP_DATABASE_TABLE',
      'MODIFY_FIREWALL_RULE',
      'RUN_ARBITRARY_SCRIPT',
    ];

    for (const action of unauthorizedActions) {
      expect(() => DeceptionActionSchema.parse(action)).toThrow();

      expect(() =>
        ModelEnrichmentResultSchema.parse({
          ...baseEnrichment,
          recommendedAction: action,
        }),
      ).toThrow();
    }
  });

  it('validates degraded model results with UNAVAILABLE provenance', () => {
    const degraded = {
      correlationId: 'corr-sim-12345',
      status: 'TIMEOUT' as const,
      reason: 'Gemini request timed out after 5000ms deadline.',
      provenance: 'UNAVAILABLE' as const,
      evaluatedAt: '2026-08-21T12:00:05.000Z',
    };

    const parsed = DegradedModelResultSchema.parse(degraded);
    expect(parsed.provenance).toBe('UNAVAILABLE');
    expect(parsed.status).toBe('TIMEOUT');
  });
});
