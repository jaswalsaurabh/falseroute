import { describe, expect, it } from 'vitest';
import {
  CreateIntrusionEventResponseSchema,
  ListIntrusionEventsResponseSchema,
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
  ApiErrorResponseSchema,
  HealthCheckResponseSchema,
  ReadinessCheckResponseSchema,
} from './api.js';

describe('API Contract Schemas', () => {
  it('validates CreateIntrusionEventResponse', () => {
    const valid = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      correlationId: 'corr-123',
      status: 'PENDING',
      message: 'Intrusion event accepted for evaluation',
      receivedAt: '2026-08-22T00:00:00.000Z',
    };
    expect(CreateIntrusionEventResponseSchema.parse(valid)).toEqual(valid);
  });

  it('validates ListIntrusionEventsResponse', () => {
    const valid = {
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
    };
    expect(ListIntrusionEventsResponseSchema.parse(valid)).toEqual(valid);
  });

  it('validates GetIntrusionEventResponse with and without simulatedEffect', () => {
    const validWithoutEffect = {
      event: {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        occurredAt: '2026-08-22T00:00:00.000Z',
        receivedAt: '2026-08-22T00:00:01.000Z',
        correlationId: 'corr-123',
        sourceIp: '192.168.1.1',
        targetAsset: 'mock-admin-portal' as const,
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT' as const,
        failedLoginCount: 3,
        riskIndicators: ['SUSPICIOUS_UA'],
        containmentMode: 'SIMULATED' as const,
        usedDecoyCredential: true as const,
        decoyIdentifier: 'mock-admin-decoy-creds' as const,
        status: 'PENDING' as const,
        provenance: 'OBSERVED' as const,
      },
    };
    expect(GetIntrusionEventResponseSchema.parse(validWithoutEffect)).toEqual(validWithoutEffect);

    const validWithEffect = {
      ...validWithoutEffect,
      simulatedEffect: {
        id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        decisionId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        correlationId: 'corr-123',
        effectKind: 'ASSIGN_FALSE_ROUTE' as const,
        status: 'RECORDED' as const,
        containmentMode: 'SIMULATED' as const,
        assignedFalseRoute: 'mock-admin-decoy' as const,
        provenance: 'DERIVED' as const,
        recordedAt: '2026-08-22T00:00:03.000Z',
        adapterVersion: 'simulated-deception-agent-v1',
      },
    };
    expect(GetIntrusionEventResponseSchema.parse(validWithEffect)).toEqual(validWithEffect);
  });

  it('validates GetDeceptionDecisionResponse with and without simulatedEffect', () => {
    const valid = {
      decision: {
        id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        correlationId: 'corr-123',
        action: 'ASSIGN_FALSE_ROUTE' as const,
        assignedFalseRoute: 'mock-admin-decoy' as const,
        matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER' as const,
        reason: 'Decoy credential trigger',
        containmentMode: 'SIMULATED' as const,
        decisionProvenance: 'DERIVED' as const,
        decidedAt: '2026-08-22T00:00:02.000Z',
        auditRecord: {
          ruleVersion: '2026.08.1',
          evaluatedAt: '2026-08-22T00:00:02.000Z',
        },
      },
      simulatedEffect: {
        id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        decisionId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        correlationId: 'corr-123',
        effectKind: 'ASSIGN_FALSE_ROUTE' as const,
        status: 'RECORDED' as const,
        containmentMode: 'SIMULATED' as const,
        assignedFalseRoute: 'mock-admin-decoy' as const,
        provenance: 'DERIVED' as const,
        recordedAt: '2026-08-22T00:00:03.000Z',
        adapterVersion: 'simulated-deception-agent-v1',
      },
    };
    expect(GetDeceptionDecisionResponseSchema.parse(valid)).toEqual(valid);
  });

  it('validates ApiErrorResponse', () => {
    const valid = {
      error: 'UNAUTHORIZED',
      message: 'Invalid operator token provided',
      correlationId: 'corr-err-123',
      details: ['Header missing'],
    };
    expect(ApiErrorResponseSchema.parse(valid)).toEqual(valid);
  });

  it('validates HealthCheckResponse and ReadinessCheckResponse', () => {
    const health = {
      status: 'ok' as const,
      timestamp: '2026-08-22T00:00:00.000Z',
    };
    expect(HealthCheckResponseSchema.parse(health)).toEqual(health);

    const ready = {
      status: 'ready' as const,
      database: 'connected' as const,
      timestamp: '2026-08-22T00:00:00.000Z',
    };
    expect(ReadinessCheckResponseSchema.parse(ready)).toEqual(ready);
  });
});
