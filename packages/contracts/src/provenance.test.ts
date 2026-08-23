import { describe, it, expect } from 'vitest';
import { ProvenanceClassificationSchema, EvidenceRecordSchema } from './provenance.js';

describe('Contracts — Provenance & Evidence Classification', () => {
  it('accepts valid provenance classifications', () => {
    const valid = ['OBSERVED', 'INFERRED', 'DERIVED', 'UNAVAILABLE', 'OPERATOR'];
    for (const val of valid) {
      expect(ProvenanceClassificationSchema.parse(val)).toBe(val);
    }
  });

  it('rejects invalid provenance classifications', () => {
    expect(() => ProvenanceClassificationSchema.parse('FACT')).toThrow();
    expect(() => ProvenanceClassificationSchema.parse('GUESS')).toThrow();
  });

  it('parses valid evidence records with bounding and confidence', () => {
    const record = {
      classification: 'OBSERVED' as const,
      source: 'auth-gateway-simulator',
      observedAt: '2026-08-21T12:00:00.000Z',
      confidence: 1.0,
      notes: 'Direct authentication failure observed.',
    };

    const parsed = EvidenceRecordSchema.parse(record);
    expect(parsed).toEqual(record);
  });

  it('rejects evidence records with unknown fields or invalid confidence', () => {
    const unknownFieldRecord = {
      classification: 'OBSERVED',
      source: 'auth-gateway-simulator',
      observedAt: '2026-08-21T12:00:00.000Z',
      extraField: 'prohibited',
    };
    expect(() => EvidenceRecordSchema.parse(unknownFieldRecord)).toThrow();

    const invalidConfidenceRecord = {
      classification: 'INFERRED',
      source: 'gemini',
      observedAt: '2026-08-21T12:00:00.000Z',
      confidence: 1.5,
    };
    expect(() => EvidenceRecordSchema.parse(invalidConfidenceRecord)).toThrow();
  });
});
