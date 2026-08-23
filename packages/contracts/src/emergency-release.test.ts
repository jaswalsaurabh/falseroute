import { describe, it, expect } from 'vitest';
import {
  EmergencyReleaseRequestSchema,
  EmergencyReleaseResponseSchema,
} from './emergency-release.js';

describe('Emergency Release Contracts', () => {
  it('validates EmergencyReleaseRequestSchema with valid input', () => {
    const valid = {
      idempotencyKey: 'em-rel-12345',
      reason: 'Operator requested complete incident rollback',
      confirmed: true,
      requestedBy: 'operator-test',
    };
    const parsed = EmergencyReleaseRequestSchema.parse(valid);
    expect(parsed.idempotencyKey).toBe('em-rel-12345');
    expect(parsed.confirmed).toBe(true);
    expect(parsed.reason).toBe('Operator requested complete incident rollback');
  });

  it('rejects EmergencyReleaseRequestSchema when idempotencyKey is missing', () => {
    expect(() =>
      EmergencyReleaseRequestSchema.parse({
        reason: 'Rollback test',
        confirmed: true,
      }),
    ).toThrow();
  });

  it('rejects EmergencyReleaseRequestSchema when confirmed is false or omitted', () => {
    expect(() =>
      EmergencyReleaseRequestSchema.parse({
        idempotencyKey: 'em-rel-123',
        reason: 'Rollback test',
        confirmed: false,
      }),
    ).toThrow();

    expect(() =>
      EmergencyReleaseRequestSchema.parse({
        idempotencyKey: 'em-rel-123',
        reason: 'Rollback test',
      }),
    ).toThrow();
  });

  it('rejects EmergencyReleaseRequestSchema with empty reason', () => {
    expect(() =>
      EmergencyReleaseRequestSchema.parse({
        idempotencyKey: 'em-rel-123',
        reason: '',
        confirmed: true,
      }),
    ).toThrow();
  });

  it('validates EmergencyReleaseResponseSchema adhering to truthful SIMULATED status', () => {
    const valid = {
      idempotencyKey: 'em-rel-12345',
      status: 'RECORDED',
      containmentMode: 'SIMULATED',
      releasedCount: {
        falseRoutes: 2,
        quarantines: 1,
        decoys: 1,
      },
      requestedCount: 4,
      verifiedCount: 3,
      pendingCount: 1,
      failedCount: 0,
      timestamp: '2026-08-23T09:30:00.000Z',
      message: 'Emergency release recorded (SIMULATED mode); 4 active leases released',
    };
    const parsed = EmergencyReleaseResponseSchema.parse(valid);
    expect(parsed.status).toBe('RECORDED');
    expect(parsed.containmentMode).toBe('SIMULATED');
    expect(parsed.releasedCount.falseRoutes).toBe(2);
    expect(parsed.requestedCount).toBe(4);
    expect(parsed.verifiedCount).toBe(3);
    expect(parsed.pendingCount).toBe(1);
  });

  it('rejects EmergencyReleaseResponseSchema claiming live execution or invalid status', () => {
    const invalid = {
      idempotencyKey: 'em-rel-123',
      status: 'EXECUTED',
      containmentMode: 'SIMULATED',
      releasedCount: { falseRoutes: 1, quarantines: 0, decoys: 0 },
      requestedCount: 1,
      verifiedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      timestamp: '2026-08-23T09:30:00.000Z',
      message: 'Executed live rollback',
    };
    expect(() => EmergencyReleaseResponseSchema.parse(invalid)).toThrow();
  });
});
