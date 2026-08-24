import { describe, expect, it, vi } from 'vitest';
import { type IntrusionEventEnvelope } from '@false-route/contracts';
import { LiveAutonomousGeminiAdapter } from './autonomous-gemini-adapter.js';

const mockEnvelope: IntrusionEventEnvelope = {
  eventId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'corr-live-gemini-001',
  schemaVersion: '1.0.0',
  source: 'PUB_SUB',
  scenarioKind: 'ENV_FILE_PROBE',
  occurredAt: '2026-08-22T00:00:00.000Z',
  publishedAt: '2026-08-22T00:00:01.000Z',
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

describe('LiveAutonomousGeminiAdapter', () => {
  it('extracts confidence solely from structured recommend_response_plan and uses application-owned summary', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
      requestTimeoutMs: 2000,
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      text: 'RAW MODEL EXPLANATION AND PROSE WITH SENSITIVE KEY: not-a-real-secret-key-12345',
      functionCalls: [
        {
          name: 'recommend_response_plan',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
            rationale: 'Validated structured plan',
            confidence: 0.94,
          },
        },
        {
          name: 'request_decoy_deployment',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Deploy decoy',
          },
        },
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('SUCCESS');
    const callArgs = generateContentMock.mock.calls[0]?.[0];
    const modelInput = JSON.parse(callArgs.contents[0].parts[0].text as string) as {
      eventId?: string;
    };
    expect(modelInput.eventId).toBe(mockEnvelope.eventId);
    if (result.status === 'SUCCESS') {
      expect(result.confidence).toBe(0.94);
      // Raw model text must NOT appear in summary
      expect(result.summary).not.toContain('RAW MODEL EXPLANATION');
      expect(result.summary).not.toContain('not-a-real-secret-key-12345');
      expect(result.summary).toBe(
        'Gemini returned 2 validated bounded tool requests for ENV_FILE_PROBE',
      );
      expect(result.toolRequests.length).toBe(2);
    }
  });

  it('preserves low structured confidence from recommend_response_plan (tool count does not dictate confidence)', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      functionCalls: [
        {
          name: 'recommend_response_plan',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['ALERT_OPERATOR'],
            rationale: 'Uncertain observation',
            confidence: 0.32,
          },
        },
        {
          name: 'request_decoy_deployment',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Deploy decoy',
          },
        },
        {
          name: 'request_false_route_assignment',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            sourceIp: '198.51.100.25',
            targetDecoyService: 'mock-admin-decoy',
            ttlSeconds: 300,
            reason: 'Divert traffic',
          },
        },
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      // Despite having 3 tools, confidence must be 0.32 from recommend_response_plan, not invented 0.9!
      expect(result.confidence).toBe(0.32);
    }
  });

  it('returns degraded INVALID_OUTPUT if recommend_response_plan is missing (missing confidence)', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
    });

    // Model only returns action requests without recommend_response_plan
    const generateContentMock = vi.fn().mockResolvedValue({
      functionCalls: [
        {
          name: 'request_decoy_deployment',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Deploy decoy',
          },
        },
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
    if (result.status === 'INVALID_OUTPUT') {
      expect(result.reason).toContain('recommend_response_plan');
    }
  });

  it('returns degraded INVALID_OUTPUT if duplicate recommend_response_plan calls exist', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      functionCalls: [
        {
          name: 'recommend_response_plan',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['DEPLOY_DECOY'],
            rationale: 'Plan 1',
            confidence: 0.9,
          },
        },
        {
          name: 'recommend_response_plan',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            recommendedActions: ['ALERT_OPERATOR'],
            rationale: 'Plan 2',
            confidence: 0.4,
          },
        },
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
  });

  it('returns degraded INVALID_OUTPUT for schema-invalid arguments without echoing raw text', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
    });

    const generateContentMock = vi.fn().mockResolvedValue({
      functionCalls: [
        {
          name: 'request_decoy_deployment',
          args: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'UNALLOWLISTED-TEMPLATE-INJECTION',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Deploy invalid',
          },
        },
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    expect(result.provenance).toBe('UNAVAILABLE');
    if (result.status === 'INVALID_OUTPUT') {
      expect(result.reason).toBe('Model returned schema-invalid tool request parameters');
      expect(result.reason).not.toContain('UNALLOWLISTED-TEMPLATE-INJECTION');
    }
  });

  it('returns degraded INVALID_OUTPUT when more than 5 tool requests are returned', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
    });

    const singleCall = {
      name: 'request_operator_alert',
      args: {
        eventId: '11111111-1111-4111-8111-111111111111',
        severity: 'HIGH',
        headline: 'Alert',
        details: 'Details',
      },
    };

    const generateContentMock = vi.fn().mockResolvedValue({
      functionCalls: [
        singleCall,
        singleCall,
        singleCall,
        singleCall,
        singleCall,
        singleCall, // 6 calls
      ],
    });

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('INVALID_OUTPUT');
    if (result.status === 'INVALID_OUTPUT') {
      expect(result.reason).toBe('Model exceeded maximum allowed tool requests count (5)');
    }
  });

  it('enforces the one-provider-call limit and does not issue retries on failure', async () => {
    const adapter = new LiveAutonomousGeminiAdapter({
      apiKey: 'test-api-key',
      modelName: 'gemini-2.5-flash',
      requestTimeoutMs: 2000,
    });

    const generateContentMock = vi
      .fn()
      .mockRejectedValue(new Error('Transient 503 service unavailable'));

    Object.defineProperty(adapter, 'client', {
      value: { models: { generateContent: generateContentMock } },
    });

    const result = await adapter.analyzeEnvelope(mockEnvelope);

    expect(result.status).toBe('UNAVAILABLE');
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});
