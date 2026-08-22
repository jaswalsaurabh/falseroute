import { describe, it, expect } from 'vitest';
import { FakeAutonomousGeminiAdapter } from './fake-autonomous-gemini-adapter.js';
import { type IntrusionEventEnvelope } from '@false-route/contracts';

describe('FakeAutonomousGeminiAdapter', () => {
  const baseEnvelope: IntrusionEventEnvelope = {
    eventId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-test-fake-gemini',
    schemaVersion: '1.0.0',
    source: 'PUB_SUB',
    scenarioKind: 'ENV_FILE_PROBE',
    occurredAt: '2026-08-22T10:00:00.000Z',
    publishedAt: '2026-08-22T10:00:01.000Z',
    sourceIp: '198.51.100.25',
    evidence: {
      scenarioKind: 'ENV_FILE_PROBE',
      requestedPath: '/.env',
      httpMethod: 'GET',
      userAgent: 'not-a-real-scanner/1.0',
      sourceIp: '198.51.100.25',
      matchedString: '.env',
      isPositiveMatch: true,
    },
    provenance: 'OBSERVED',
  };

  it('produces valid tool requests starting with recommend_response_plan in auto/success mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('auto');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.toolRequests.length).toBeGreaterThanOrEqual(1);
      expect(result.toolRequests[0]!.toolName).toBe('recommend_response_plan');
      expect(result.provenance).toBe('INFERRED');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('returns degraded result in timeout mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('timeout');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('TIMEOUT');
    expect(result.provenance).toBe('UNAVAILABLE');
    if (result.status === 'TIMEOUT') {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns degraded result in unavailable mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('unavailable');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.provenance).toBe('UNAVAILABLE');
  });

  it('returns degraded result in rate-limited and server-error modes', async () => {
    const rateLimitedAdapter = new FakeAutonomousGeminiAdapter('rate-limited');
    const rateLimitedResult = await rateLimitedAdapter.analyzeEnvelope(baseEnvelope);
    expect(rateLimitedResult.status).toBe('UNAVAILABLE');
    expect(rateLimitedResult.provenance).toBe('UNAVAILABLE');

    const serverErrorAdapter = new FakeAutonomousGeminiAdapter('server-error');
    const serverErrorResult = await serverErrorAdapter.analyzeEnvelope(baseEnvelope);
    expect(serverErrorResult.status).toBe('UNAVAILABLE');
    expect(serverErrorResult.provenance).toBe('UNAVAILABLE');
  });

  it('returns degraded INVALID_OUTPUT in excessive-requests mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('excessive-requests');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
    if (result.status === 'INVALID_OUTPUT') {
      expect(result.reason).toContain('maximum allowed tool requests count');
    }
  });

  it('returns degraded INVALID_OUTPUT in unsafe-resource-request mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('unsafe-resource-request');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
    if (result.status === 'INVALID_OUTPUT') {
      expect(result.reason).toContain('schema-invalid');
    }
  });

  it('returns degraded result in malformed-arguments mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('malformed-arguments');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
  });

  it('returns degraded result in unknown-tool mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('unknown-tool');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
  });

  it('returns low confidence analysis in low-confidence mode with structured response plan', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('low-confidence');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.confidence).toBe(0.25);
      expect(result.toolRequests[0]!.toolName).toBe('recommend_response_plan');
      expect(result.toolRequests[0]!.parameters['confidence']).toBe(0.25);
    }
  });

  it('returns repeated tool requests in repeated-requests mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('repeated-requests');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.toolRequests.length).toBe(3);
      expect(result.toolRequests[0]!.toolName).toBe('recommend_response_plan');
      expect(result.toolRequests[1]!.toolName).toBe('request_operator_alert');
      expect(result.toolRequests[2]!.toolName).toBe('request_operator_alert');
    }
  });

  it('returns conflicting requests in conflicting-requests mode', async () => {
    const adapter = new FakeAutonomousGeminiAdapter('conflicting-requests');
    const result = await adapter.analyzeEnvelope(baseEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      const toolNames = result.toolRequests.map((r) => r.toolName);
      expect(toolNames).toContain('recommend_response_plan');
      expect(toolNames).toContain('request_false_route_assignment');
      expect(toolNames).toContain('request_source_quarantine');
    }
  });

  it('handles transient failures before success', async () => {
    const adapter = new FakeAutonomousGeminiAdapter({
      mode: 'auto',
      transientFailuresBeforeSuccess: 2,
    });

    const attempt1 = await adapter.analyzeEnvelope(baseEnvelope);
    expect(attempt1.status).toBe('UNAVAILABLE');

    const attempt2 = await adapter.analyzeEnvelope(baseEnvelope);
    expect(attempt2.status).toBe('UNAVAILABLE');

    const attempt3 = await adapter.analyzeEnvelope(baseEnvelope);
    expect(attempt3.status).toBe('SUCCESS');
  });

  it('returns NO_ACTION recommendation for negative control envelope', async () => {
    const negControlEnvelope: IntrusionEventEnvelope = {
      ...baseEnvelope,
      evidence: {
        ...baseEnvelope.evidence,
        isPositiveMatch: false,
        isNegativeControl: true,
      },
    };

    const adapter = new FakeAutonomousGeminiAdapter('auto');
    const result = await adapter.analyzeEnvelope(negControlEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.toolRequests.length).toBe(1);
      expect(result.toolRequests[0]!.toolName).toBe('recommend_response_plan');
      expect(result.toolRequests[0]!.parameters['recommendedActions']).toEqual(['NO_ACTION']);
    }
  });
});
