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

  it('validates GetIntrusionEventResponse with pending event without decision/effect', () => {
    const validPending = {
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
    expect(GetIntrusionEventResponseSchema.parse(validPending)).toEqual(validPending);
  });

  it('validates GetIntrusionEventResponse with decided ASSIGN_FALSE_ROUTE and valid simulatedEffect', () => {
    const validDecided = {
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
        status: 'DECIDED' as const,
        provenance: 'OBSERVED' as const,
      },
      decision: {
        id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        correlationId: 'corr-123',
        action: 'ASSIGN_FALSE_ROUTE' as const,
        assignedFalseRoute: 'mock-admin-decoy' as const,
        matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER' as const,
        reason: 'Decoy credential trigger matched',
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
    expect(GetIntrusionEventResponseSchema.parse(validDecided)).toEqual(validDecided);
  });

  it('rejects contradictory evidence combinations in GetIntrusionEventResponse', () => {
    const baseEvent = {
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
      status: 'DECIDED' as const,
      provenance: 'OBSERVED' as const,
    };

    const validDecision = {
      id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      correlationId: 'corr-123',
      action: 'ASSIGN_FALSE_ROUTE' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
      matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER' as const,
      reason: 'Decoy credential trigger matched',
      containmentMode: 'SIMULATED' as const,
      decisionProvenance: 'DERIVED' as const,
      decidedAt: '2026-08-22T00:00:02.000Z',
      auditRecord: {
        ruleVersion: '2026.08.1',
        evaluatedAt: '2026-08-22T00:00:02.000Z',
      },
    };

    const validEffect = {
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
    };

    // 1. simulatedEffect present without decision
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        simulatedEffect: validEffect,
      }),
    ).toThrow('simulatedEffect cannot be present when decision is null or undefined');

    // 2. ASSIGN_FALSE_ROUTE decision without simulatedEffect
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        decision: validDecision,
      }),
    ).toThrow('simulatedEffect is required when decision action is ASSIGN_FALSE_ROUTE');

    // 3. OBSERVE decision with simulatedEffect
    const observeDecision = {
      id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      correlationId: 'corr-123',
      action: 'OBSERVE' as const,
      matchedPolicy: 'DEFAULT_OBSERVATION' as const,
      reason: 'No decoy trigger',
      containmentMode: 'SIMULATED' as const,
      decisionProvenance: 'DERIVED' as const,
      decidedAt: '2026-08-22T00:00:02.000Z',
      auditRecord: {
        ruleVersion: '2026.08.1',
        evaluatedAt: '2026-08-22T00:00:02.000Z',
      },
    };
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        decision: observeDecision,
        simulatedEffect: validEffect,
      }),
    ).toThrow('simulatedEffect must not be present when decision action is OBSERVE');

    // 4. Mismatched decisionId
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        decision: validDecision,
        simulatedEffect: {
          ...validEffect,
          decisionId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    ).toThrow('must match decision id');

    // 5. Mismatched correlationId
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        decision: validDecision,
        simulatedEffect: {
          ...validEffect,
          correlationId: 'corr-mismatch',
        },
      }),
    ).toThrow('must match decision correlationId');

    // 6. Event status is DECIDED but decision is missing/null
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: baseEvent,
        decision: null,
      }),
    ).toThrow('decision is required when event status is DECIDED');

    // 7. Event status is PENDING but decision is present
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: {
          ...baseEvent,
          status: 'PENDING' as const,
        },
        decision: validDecision,
        simulatedEffect: validEffect,
      }),
    ).toThrow('decision must be null or undefined when event status is PENDING');

    // 8. Event status is PROCESSING but decision is present
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: {
          ...baseEvent,
          status: 'PROCESSING' as const,
        },
        decision: validDecision,
        simulatedEffect: validEffect,
      }),
    ).toThrow('decision must be null or undefined when event status is PROCESSING');

    // 9. Event status is FAILED but decision is present
    expect(() =>
      GetIntrusionEventResponseSchema.parse({
        event: {
          ...baseEvent,
          status: 'FAILED' as const,
        },
        decision: validDecision,
        simulatedEffect: validEffect,
      }),
    ).toThrow('decision must be null or undefined when event status is FAILED');
  });

  it('validates GetDeceptionDecisionResponse with valid decision and effect', () => {
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

  it('validates GetDeceptionDecisionResponse for ALLOW/OBSERVE without simulatedEffect', () => {
    const allowResponse = {
      decision: {
        id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        correlationId: 'corr-123',
        action: 'ALLOW' as const,
        matchedPolicy: 'DEFAULT_OBSERVATION' as const,
        reason: 'Normal traffic allowed',
        containmentMode: 'SIMULATED' as const,
        decisionProvenance: 'DERIVED' as const,
        decidedAt: '2026-08-22T00:00:02.000Z',
        auditRecord: {
          ruleVersion: '2026.08.1',
          evaluatedAt: '2026-08-22T00:00:02.000Z',
        },
      },
    };
    expect(GetDeceptionDecisionResponseSchema.parse(allowResponse)).toEqual(allowResponse);
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
