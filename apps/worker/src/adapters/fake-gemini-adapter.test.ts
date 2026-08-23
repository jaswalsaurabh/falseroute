import { describe, expect, it } from 'vitest';
import { type IntrusionEvent } from '@false-route/contracts';
import { FakeGeminiAdapter } from './fake-gemini-adapter.js';

const mockEvent: IntrusionEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-test-gemini-001',
  sourceIp: '192.168.1.55',
  targetAsset: 'mock-admin-portal',
  eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
  failedLoginCount: 2,
  riskIndicators: ['SUSPICIOUS_UA'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: true,
  decoyIdentifier: 'mock-admin-decoy-creds',
  status: 'PENDING',
  provenance: 'OBSERVED',
};

describe('FakeGeminiAdapter', () => {
  it('returns valid structured recommendation for decoy events', async () => {
    const adapter = new FakeGeminiAdapter('auto');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('INFERRED');
    if ('recommendedAction' in result) {
      expect(result.recommendedAction).toBe('ASSIGN_FALSE_ROUTE');
      expect(result.suggestedFalseRoute).toBe('mock-admin-decoy');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('handles simulated timeout gracefully with degraded status', async () => {
    const adapter = new FakeGeminiAdapter('timeout');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('TIMEOUT');
      expect(result.reason).toContain('timeout');
    }
  });

  it('handles unavailable mode when GEMINI_API_KEY is not configured', async () => {
    const adapter = new FakeGeminiAdapter('unavailable');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reason).toContain('GEMINI_API_KEY not configured');
    }
  });

  it('handles simulated rate limit with degraded status', async () => {
    const adapter = new FakeGeminiAdapter('rate-limited');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reason).toContain('429');
    }
  });

  it('handles simulated server error with degraded status', async () => {
    const adapter = new FakeGeminiAdapter('server-error');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reason).toContain('503');
    }
  });

  it('handles simulated invalid output with degraded status', async () => {
    const adapter = new FakeGeminiAdapter('invalid-output');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('INVALID_OUTPUT');
    }
  });

  it('handles transient-then-success simulation', async () => {
    const adapter = new FakeGeminiAdapter({
      mode: 'auto',
      transientFailuresBeforeSuccess: 1,
    });

    const res1 = await adapter.enrichEvent(mockEvent);
    expect(res1.provenance).toBe('UNAVAILABLE');

    const res2 = await adapter.enrichEvent(mockEvent);
    expect(res2.provenance).toBe('INFERRED');
  });

  it('provides conflicting recommendation without breaking contract boundaries', async () => {
    const adapter = new FakeGeminiAdapter('conflicting-recommendation');
    const nonDecoyEvent: IntrusionEvent = {
      ...mockEvent,
      usedDecoyCredential: false,
      decoyIdentifier: undefined,
    };
    const result = await adapter.enrichEvent(nonDecoyEvent);

    expect(result.correlationId).toBe(nonDecoyEvent.correlationId);
    expect(result.provenance).toBe('INFERRED');
    if ('recommendedAction' in result) {
      expect(result.recommendedAction).toBe('ASSIGN_FALSE_ROUTE');
      expect(result.suggestedFalseRoute).toBe('mock-admin-decoy');
    }
  });
});
