import { describe, it, expect } from 'vitest';
import {
  SimulatedDeceptionCommandSchema,
  SimulatedDeceptionResultSchema,
  SimulatedDeceptionEffectSchema,
} from './simulated-deception.js';

describe('SimulatedDeceptionCommandSchema', () => {
  const validCommand = {
    decisionId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-sim-cmd-001',
    action: 'ASSIGN_FALSE_ROUTE' as const,
    containmentMode: 'SIMULATED' as const,
    assignedFalseRoute: 'mock-admin-decoy' as const,
    commandProvenance: 'DERIVED' as const,
  };

  it('validates a well-formed simulated deception command', () => {
    const parsed = SimulatedDeceptionCommandSchema.parse(validCommand);
    expect(parsed).toEqual(validCommand);
  });

  it('rejects commands with arbitrary or non-allowlisted actions', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        action: 'EXECUTE_FIREWALL_BLOCK',
      }),
    ).toThrow();
  });

  it('rejects commands with non-simulated containment modes', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        containmentMode: 'REAL',
      }),
    ).toThrow();
  });

  it('rejects commands with arbitrary or non-allowlisted false routes', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        assignedFalseRoute: 'https://malicious-sinkhole.internal/honeypot',
      }),
    ).toThrow();
  });

  it('rejects commands with non-DERIVED provenance', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        commandProvenance: 'OBSERVED',
      }),
    ).toThrow();
  });

  it('rejects commands containing raw model responses or arbitrary shell/network parameters', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        rawGeminiResponse: 'Redirect traffic to port 8080',
        prompt: 'You are a cybersecurity agent',
        command: 'iptables -A INPUT -s 10.0.0.1 -j DROP',
      }),
    ).toThrow();
  });

  it('rejects invalid decisionId or correlationId', () => {
    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        decisionId: 'not-a-uuid',
      }),
    ).toThrow();

    expect(() =>
      SimulatedDeceptionCommandSchema.parse({
        ...validCommand,
        correlationId: '',
      }),
    ).toThrow();
  });
});

describe('SimulatedDeceptionResultSchema', () => {
  const validResult = {
    status: 'RECORDED' as const,
    recordedAt: '2026-08-22T10:00:00.000Z',
    adapterVersion: 'simulated-deception-agent-v1',
    provenance: 'DERIVED' as const,
  };

  it('validates a well-formed simulated deception result', () => {
    const parsed = SimulatedDeceptionResultSchema.parse(validResult);
    expect(parsed).toEqual(validResult);
  });

  it('rejects non-RECORDED statuses such as EXECUTED, REDIRECTED, or CONTAINED', () => {
    expect(() =>
      SimulatedDeceptionResultSchema.parse({
        ...validResult,
        status: 'EXECUTED',
      }),
    ).toThrow();

    expect(() =>
      SimulatedDeceptionResultSchema.parse({
        ...validResult,
        status: 'ATTACKER_CONTAINED',
      }),
    ).toThrow();
  });

  it('rejects invalid ISO timestamp or empty adapterVersion', () => {
    expect(() =>
      SimulatedDeceptionResultSchema.parse({
        ...validResult,
        recordedAt: 'invalid-date',
      }),
    ).toThrow();

    expect(() =>
      SimulatedDeceptionResultSchema.parse({
        ...validResult,
        adapterVersion: '',
      }),
    ).toThrow();
  });

  it('rejects extraneous properties', () => {
    expect(() =>
      SimulatedDeceptionResultSchema.parse({
        ...validResult,
        networkLatencyMs: 12,
      }),
    ).toThrow();
  });
});

describe('SimulatedDeceptionEffectSchema', () => {
  const validEffect = {
    id: '22222222-2222-4222-8222-222222222222',
    decisionId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-sim-eff-001',
    effectKind: 'ASSIGN_FALSE_ROUTE' as const,
    status: 'RECORDED' as const,
    containmentMode: 'SIMULATED' as const,
    assignedFalseRoute: 'mock-admin-decoy' as const,
    provenance: 'DERIVED' as const,
    recordedAt: '2026-08-22T10:00:00.000Z',
    adapterVersion: 'simulated-deception-agent-v1',
  };

  it('validates a well-formed persisted simulated deception effect', () => {
    const parsed = SimulatedDeceptionEffectSchema.parse(validEffect);
    expect(parsed).toEqual(validEffect);
  });

  it('rejects effects with invalid kind, non-simulated mode, or non-RECORDED status', () => {
    expect(() =>
      SimulatedDeceptionEffectSchema.parse({
        ...validEffect,
        effectKind: 'ACTIVE_BLOCK',
      }),
    ).toThrow();

    expect(() =>
      SimulatedDeceptionEffectSchema.parse({
        ...validEffect,
        status: 'EXECUTED',
      }),
    ).toThrow();

    expect(() =>
      SimulatedDeceptionEffectSchema.parse({
        ...validEffect,
        containmentMode: 'REAL',
      }),
    ).toThrow();
  });
});
