import { describe, it, expect } from 'vitest';
import {
  UuidSchema,
  IsoDateTimeSchema,
  CorrelationIdSchema,
  IpAddressSchema,
  ConfidenceScoreSchema,
  TargetAssetIdentifierSchema,
  DecoyIdentifierSchema,
  FalseRouteIdentifierSchema,
  PolicyIdentifierSchema,
} from './primitives.js';

describe('Contracts — Validation Primitives', () => {
  it('validates UUIDs', () => {
    expect(UuidSchema.parse('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
    expect(() => UuidSchema.parse('invalid-uuid')).toThrow();
  });

  it('validates ISO 8601 UTC datetimes', () => {
    expect(IsoDateTimeSchema.parse('2026-08-21T12:00:00.000Z')).toBe('2026-08-21T12:00:00.000Z');
    expect(() => IsoDateTimeSchema.parse('invalid-date')).toThrow();
  });

  it('validates correlation identifiers', () => {
    expect(CorrelationIdSchema.parse('corr-12345')).toBe('corr-12345');
    expect(() => CorrelationIdSchema.parse('')).toThrow();
    expect(() => CorrelationIdSchema.parse('a'.repeat(65))).toThrow();
  });

  it('validates IPv4 and IPv6 addresses', () => {
    expect(IpAddressSchema.parse('192.0.2.1')).toBe('192.0.2.1');
    expect(IpAddressSchema.parse('2001:db8::1')).toBe('2001:db8::1');
    expect(() => IpAddressSchema.parse('999.999.999.999')).toThrow();
    expect(() => IpAddressSchema.parse('not-an-ip')).toThrow();
  });

  it('validates confidence scores between 0 and 1', () => {
    expect(ConfidenceScoreSchema.parse(0)).toBe(0);
    expect(ConfidenceScoreSchema.parse(0.5)).toBe(0.5);
    expect(ConfidenceScoreSchema.parse(1)).toBe(1);
    expect(() => ConfidenceScoreSchema.parse(-0.01)).toThrow();
    expect(() => ConfidenceScoreSchema.parse(1.01)).toThrow();
  });

  it('validates application-defined identifier enums', () => {
    expect(TargetAssetIdentifierSchema.parse('mock-admin-portal')).toBe('mock-admin-portal');
    expect(() => TargetAssetIdentifierSchema.parse('production-payment-gateway')).toThrow();

    expect(DecoyIdentifierSchema.parse('mock-admin-decoy-creds')).toBe('mock-admin-decoy-creds');
    expect(() => DecoyIdentifierSchema.parse('real-admin-creds')).toThrow();

    expect(FalseRouteIdentifierSchema.parse('mock-admin-decoy')).toBe('mock-admin-decoy');
    expect(() => FalseRouteIdentifierSchema.parse('https://external-honeypot.com')).toThrow();

    expect(PolicyIdentifierSchema.parse('DECOY_CREDENTIAL_TRIGGER')).toBe(
      'DECOY_CREDENTIAL_TRIGGER',
    );
    expect(PolicyIdentifierSchema.parse('HIGH_RISK_THRESHOLD')).toBe('HIGH_RISK_THRESHOLD');
    expect(PolicyIdentifierSchema.parse('DEFAULT_OBSERVATION')).toBe('DEFAULT_OBSERVATION');
    expect(() => PolicyIdentifierSchema.parse('UNKNOWN_POLICY')).toThrow();
  });
});
