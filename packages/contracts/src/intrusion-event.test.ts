import { describe, it, expect } from 'vitest';
import { SimulatedIntrusionEventInputSchema, IntrusionEventSchema } from './intrusion-event.js';

describe('Contracts — Intrusion Event & Decoy Evidence Discrimination', () => {
  const baseEvent = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    occurredAt: '2026-08-21T12:00:00.000Z',
    correlationId: 'corr-sim-12345',
    sourceIp: '192.0.2.1',
    targetAsset: 'mock-admin-portal' as const,
    eventType: 'SUSPICIOUS_LOGIN' as const,
    failedLoginCount: 5,
    riskIndicators: ['known_decoy_credential_used', 'rapid_failed_attempts'],
    containmentMode: 'SIMULATED' as const,
  };

  it('validates a correct decoy-triggered intrusion event', () => {
    const decoyEvent = {
      ...baseEvent,
      usedDecoyCredential: true as const,
      decoyIdentifier: 'mock-admin-decoy-creds' as const,
    };

    const parsed = SimulatedIntrusionEventInputSchema.parse(decoyEvent);
    expect(parsed).toEqual(decoyEvent);
  });

  it('validates a correct standard intrusion event without decoy credentials', () => {
    const standardEvent = {
      ...baseEvent,
      usedDecoyCredential: false as const,
    };

    const parsed = SimulatedIntrusionEventInputSchema.parse(standardEvent);
    expect(parsed).toEqual(standardEvent);
  });

  it('rejects contradictory decoy evidence states', () => {
    // Contradiction 1: usedDecoyCredential is false but decoyIdentifier is present
    const falseWithIdentifier = {
      ...baseEvent,
      usedDecoyCredential: false,
      decoyIdentifier: 'mock-admin-decoy-creds',
    };
    expect(() => SimulatedIntrusionEventInputSchema.parse(falseWithIdentifier)).toThrow();

    // Contradiction 2: usedDecoyCredential is true but decoyIdentifier is missing
    const trueWithoutIdentifier = {
      ...baseEvent,
      usedDecoyCredential: true,
    };
    expect(() => SimulatedIntrusionEventInputSchema.parse(trueWithoutIdentifier)).toThrow();

    // Contradiction 3: usedDecoyCredential is true but decoyIdentifier is unapproved
    const trueWithInvalidIdentifier = {
      ...baseEvent,
      usedDecoyCredential: true,
      decoyIdentifier: 'unapproved-decoy',
    };
    expect(() => SimulatedIntrusionEventInputSchema.parse(trueWithInvalidIdentifier)).toThrow();
  });

  it('rejects unknown fields on simulated intrusion event input', () => {
    const inputWithExtra = {
      ...baseEvent,
      usedDecoyCredential: true as const,
      decoyIdentifier: 'mock-admin-decoy-creds' as const,
      untrustedPayload: 'malicious_data',
    };
    expect(() => SimulatedIntrusionEventInputSchema.parse(inputWithExtra)).toThrow();
  });

  it('validates internal IntrusionEvent representation with OBSERVED provenance', () => {
    const internalEvent = {
      ...baseEvent,
      usedDecoyCredential: true as const,
      decoyIdentifier: 'mock-admin-decoy-creds' as const,
      receivedAt: '2026-08-21T12:00:01.000Z',
      status: 'PENDING' as const,
      provenance: 'OBSERVED' as const,
    };

    const parsed = IntrusionEventSchema.parse(internalEvent);
    expect(parsed.provenance).toBe('OBSERVED');
    expect(parsed.status).toBe('PENDING');
  });
});
