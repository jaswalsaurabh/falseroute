import { describe, expect, it, vi } from 'vitest';
import { type IntrusionEvent } from '@false-route/contracts';
import { FakeGeminiAdapter } from './fake-gemini-adapter.js';
import { LiveGeminiAdapter } from './gemini-adapter.js';

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

  it('handles simulated upstream unavailability with degraded status', async () => {
    const adapter = new FakeGeminiAdapter('unavailable');
    const result = await adapter.enrichEvent(mockEvent);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
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
});

describe('LiveGeminiAdapter', () => {
  it('classifies schema-invalid Gemini JSON output as INVALID_OUTPUT via ZodError', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      timeoutMs: 2000,
    });

    // Mock client.models.generateContent to return JSON violating ModelEnrichmentResultSchema
    const generateContentMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        recommendedAction: 'NON_EXISTENT_ACTION_ENUM',
        confidence: 1.5, // Exceeds 1.0 bound
        summary: 'Invalid assessment',
        explanation: 'Invalid explanation',
      }),
    });

    Object.defineProperty(adapter, 'client', {
      value: {
        models: {
          generateContent: generateContentMock,
        },
      },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledOnce();
    const callArgs = generateContentMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.config?.abortSignal).toBeDefined();
    expect(callArgs?.config?.abortSignal instanceof AbortSignal).toBe(true);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('INVALID_OUTPUT');
      expect(result.reason).toContain('schema-invalid structured output');
    } else {
      expect.fail('Expected degraded model result');
    }
  });

  it('passes abortSignal and bounds output tokens when calling generateContent', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      timeoutMs: 2000,
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        recommendedAction: 'ASSIGN_FALSE_ROUTE',
        suggestedFalseRoute: 'mock-admin-decoy',
        confidence: 0.95,
        summary: 'Decoy asset targeted',
        explanation: 'Fictional decoy credential was observed in authentication attempt.',
      }),
    });

    Object.defineProperty(adapter, 'client', {
      value: {
        models: {
          generateContent: generateContentMock,
        },
      },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledOnce();
    const callArgs = generateContentMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs?.config?.maxOutputTokens).toBe(1024);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('INFERRED');
    if ('recommendedAction' in result) {
      expect(result.recommendedAction).toBe('ASSIGN_FALSE_ROUTE');
      expect(result.suggestedFalseRoute).toBe('mock-admin-decoy');
    } else {
      expect.fail('Expected valid ModelEnrichmentResult');
    }
  });
});
