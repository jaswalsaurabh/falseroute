import { describe, expect, it, vi } from 'vitest';
import { type IntrusionEvent } from '@false-route/contracts';
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

describe('LiveGeminiAdapter', () => {
  it('passes abortSignal and bounds output tokens when calling generateContent', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      requestTimeoutMs: 2000,
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
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledOnce();
    const callArgs = generateContentMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs?.config?.maxOutputTokens).toBe(1024);

    expect(result.correlationId).toBe(mockEvent.correlationId);
    expect(result.provenance).toBe('INFERRED');
  });

  it('never retries schema-invalid output (fails fast with INVALID_OUTPUT on attempt 1)', async () => {
    const sleepMock = vi.fn();
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      maxRetries: 3,
      sleepFn: sleepMock,
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        recommendedAction: 'NON_EXISTENT_ACTION_ENUM',
        confidence: 1.5,
        summary: 'Invalid assessment',
        explanation: 'Invalid explanation',
      }),
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(sleepMock).not.toHaveBeenCalled();
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('INVALID_OUTPUT');
    }
  });

  it('never retries terminal 401/403/404 authentication errors', async () => {
    const sleepMock = vi.fn();
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      maxRetries: 3,
      sleepFn: sleepMock,
    });

    const authError = Object.assign(new Error('API key invalid'), { status: 401 });
    const generateContentMock = vi.fn().mockRejectedValue(authError);

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(sleepMock).not.toHaveBeenCalled();
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reason).toContain('401');
    }
  });

  it('retries transient 503 errors and recovers successfully on attempt 2', async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      maxRetries: 2,
      initialDelayMs: 100,
      sleepFn: sleepMock,
      randomFn: () => 0,
    });

    const error503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const successResponse = {
      text: JSON.stringify({
        recommendedAction: 'ASSIGN_FALSE_ROUTE',
        suggestedFalseRoute: 'mock-admin-decoy',
        confidence: 0.92,
        summary: 'Recovered after transient error',
        explanation: 'Successful enrichment on retry attempt.',
      }),
    };

    const generateContentMock = vi
      .fn()
      .mockRejectedValueOnce(error503)
      .mockResolvedValueOnce(successResponse);

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledOnce();
    expect(sleepMock).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(result.provenance).toBe('INFERRED');
  });

  it('exhausts retries on persistent transient 429 and returns degraded result', async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      maxRetries: 2,
      sleepFn: sleepMock,
      randomFn: () => 0,
    });

    const rateLimitError = Object.assign(new Error('Resource exhausted: 429 Too Many Requests'), {
      status: 429,
    });
    const generateContentMock = vi.fn().mockRejectedValue(rateLimitError);

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(generateContentMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reason).toContain('429');
    }
  });

  it('enforces complete operation deadline across retries', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      operationDeadlineMs: 50,
      requestTimeoutMs: 100,
      maxRetries: 3,
    });

    const generateContentMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { text: '{}' };
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.enrichEvent(mockEvent);

    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('TIMEOUT');
      expect(result.reason).toContain('deadline exceeded');
    }
  });

  it('rejects with degraded UNAVAILABLE state when concurrency is saturated', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
      maxConcurrency: 1,
      maxQueueSize: 0,
    });

    let releaseFirst: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const generateContentMock = vi.fn().mockImplementation(async () => {
      await blocker;
      return {
        text: JSON.stringify({
          recommendedAction: 'OBSERVE',
          confidence: 0.7,
          summary: 'Blocked then completed',
          explanation: 'Valid response',
        }),
      };
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const req1 = adapter.enrichEvent(mockEvent);
    const req2 = await adapter.enrichEvent(mockEvent);

    expect(req2.provenance).toBe('UNAVAILABLE');
    if ('status' in req2) {
      expect(req2.status).toBe('UNAVAILABLE');
      expect(req2.reason).toContain('saturated');
    }

    releaseFirst!();
    await req1;
  });

  it('respects parent caller abort signal immediately', async () => {
    const adapter = new LiveGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-3.5-flash',
    });

    const parentAbort = new AbortController();
    parentAbort.abort(new Error('Caller cancelled before request'));

    const result = await adapter.enrichEvent(mockEvent, parentAbort.signal);

    expect(result.provenance).toBe('UNAVAILABLE');
    if ('status' in result) {
      expect(result.status).toBe('TIMEOUT');
    }
  });
});
