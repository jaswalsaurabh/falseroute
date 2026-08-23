import { describe, expect, it, vi } from 'vitest';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
} from '@false-route/contracts';
import { createLogger } from '@false-route/observability';
import { Writable } from 'node:stream';
import { EventProcessor } from './event-processor.js';
import { FakeGeminiAdapter } from '../adapters/fake-gemini-adapter.js';
import {
  DeterministicSimulatedDeceptionAdapter,
  type SimulatedDeceptionAgent,
} from '../adapters/simulated-deception-agent.js';
import {
  type WorkerRepository,
  type ClaimReleaseOutcome,
} from '../persistence/worker-repository.js';
import { type GeminiBudgetService } from '../services/gemini-budget-service.js';

const mockDecoyEvent: IntrusionEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-proc-001',
  sourceIp: '192.168.1.100',
  targetAsset: 'mock-admin-portal',
  eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
  failedLoginCount: 3,
  riskIndicators: ['SUSPICIOUS_USER_AGENT'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: true,
  decoyIdentifier: 'mock-admin-decoy-creds',
  status: 'PROCESSING',
  provenance: 'OBSERVED',
};

const mockNonDecoyEvent: IntrusionEvent = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  occurredAt: '2026-08-22T00:00:00.000Z',
  receivedAt: '2026-08-22T00:00:01.000Z',
  correlationId: 'corr-proc-002',
  sourceIp: '10.0.0.50',
  targetAsset: 'mock-admin-portal',
  eventType: 'SUSPICIOUS_LOGIN',
  failedLoginCount: 1,
  riskIndicators: ['UNUSUAL_TIME'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: false,
  status: 'PROCESSING',
  provenance: 'OBSERVED',
};

function createMockRepository(): {
  repository: WorkerRepository;
  persistedDecisions: Array<{
    decision: DeceptionDecision;
    claimToken: string;
    simulatedEffect?: SimulatedDeceptionEffect | undefined;
  }>;
  claimedEvents: IntrusionEvent[];
  releasedClaims: Array<{ eventId: string; claimToken: string; outcome: ClaimReleaseOutcome }>;
} {
  const persistedDecisions: Array<{
    decision: DeceptionDecision;
    claimToken: string;
    simulatedEffect?: SimulatedDeceptionEffect | undefined;
  }> = [];
  const claimedEvents: IntrusionEvent[] = [];
  const releasedClaims: Array<{
    eventId: string;
    claimToken: string;
    outcome: ClaimReleaseOutcome;
  }> = [];

  const repository: WorkerRepository = {
    async claimNextPendingEvent() {
      const event = claimedEvents.shift();
      if (!event) return null;
      return { event, claimToken: `claim-${event.id}` };
    },
    async persistDecision(
      decision: DeceptionDecision,
      claimToken: string,
      simulatedEffect?: SimulatedDeceptionEffect | undefined,
    ) {
      persistedDecisions.push({ decision, claimToken, simulatedEffect });
    },
    async releaseOrFailClaim(eventId: string, claimToken: string) {
      const outcome: ClaimReleaseOutcome = 'FAILED';
      releasedClaims.push({ eventId, claimToken, outcome });
      return outcome;
    },
    async checkHealth() {
      return true;
    },
  };

  return { repository, persistedDecisions, claimedEvents, releasedClaims };
}

function createCapturingLogger() {
  const rawLines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      rawLines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({
    serviceName: 'capturing-test-worker',
    level: 'trace',
    destination: stream,
  });
  return { logger, rawLines };
}

const noopLogger = createLogger({
  serviceName: 'test-worker',
  destination: new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
});

describe('EventProcessor', () => {
  const defaultAgent = new DeterministicSimulatedDeceptionAdapter();

  it('processes decoy event and persists ASSIGN_FALSE_ROUTE decision and simulated effect', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision).toBeDefined();
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    if (result.decision?.action === 'ASSIGN_FALSE_ROUTE') {
      expect(result.decision.assignedFalseRoute).toBe('mock-admin-decoy');
    }
    expect(persistedDecisions.length).toBe(1);
    expect(persistedDecisions[0]?.decision.eventId).toBe(mockDecoyEvent.id);
    expect(persistedDecisions[0]?.claimToken).toBe(`claim-${mockDecoyEvent.id}`);
    expect(persistedDecisions[0]?.simulatedEffect).toBeDefined();
    expect(persistedDecisions[0]?.simulatedEffect?.status).toBe('RECORDED');
    expect(persistedDecisions[0]?.simulatedEffect?.containmentMode).toBe('SIMULATED');
    expect(persistedDecisions[0]?.simulatedEffect?.assignedFalseRoute).toBe('mock-admin-decoy');
  });

  it('processes non-decoy event without assigning false route or creating simulated effect', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockNonDecoyEvent);

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('OBSERVE');
    expect(persistedDecisions.length).toBe(1);
    expect(persistedDecisions[0]?.decision.action).not.toBe('ASSIGN_FALSE_ROUTE');
    expect(persistedDecisions[0]?.simulatedEffect).toBeUndefined();
  });

  it('completes deterministic decision when Gemini times out', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const timeoutAdapter = new FakeGeminiAdapter('timeout');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: timeoutAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.decision?.modelEnrichment?.provenance).toBe('UNAVAILABLE');
    expect(persistedDecisions.length).toBe(1);
    expect(persistedDecisions[0]?.simulatedEffect?.status).toBe('RECORDED');
  });

  it('completes deterministic decision when provider is rate limited (429)', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const rateLimitAdapter = new FakeGeminiAdapter('rate-limited');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: rateLimitAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.decision?.modelEnrichment?.provenance).toBe('UNAVAILABLE');
    expect(persistedDecisions.length).toBe(1);
  });

  it('completes deterministic decision when provider concurrency is saturated', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const saturatedAdapter = new FakeGeminiAdapter('concurrency-saturation');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: saturatedAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.decision?.modelEnrichment?.provenance).toBe('UNAVAILABLE');
    expect(persistedDecisions.length).toBe(1);
  });

  it('completes deterministic decision when Gemini returns invalid output', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const invalidAdapter = new FakeGeminiAdapter('invalid-output');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: invalidAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(persistedDecisions.length).toBe(1);
  });

  it('enforces deterministic non-decoy policy even if model recommends false route', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockNonDecoyEvent);

    const conflictingAdapter = new FakeGeminiAdapter('conflicting-recommendation');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: conflictingAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('OBSERVE');
    expect(persistedDecisions[0]?.decision.action).not.toBe('ASSIGN_FALSE_ROUTE');
    expect(persistedDecisions[0]?.simulatedEffect).toBeUndefined();
  });

  it('completes deterministic decision safely when adapter returns mismatched correlation ID', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const mismatchedAdapter = {
      async enrichEvent() {
        return {
          correlationId: 'corr-different-mismatched',
          status: 'DEGRADED' as const,
          reason: 'Corrupt correlation',
          provenance: 'UNAVAILABLE' as const,
          evaluatedAt: new Date().toISOString(),
        };
      },
    };

    const processor = new EventProcessor({
      repository,
      geminiAdapter: mismatchedAdapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.decision?.modelEnrichment?.provenance).toBe('UNAVAILABLE');
    expect(persistedDecisions.length).toBe(1);
  });

  it('returns processed: false when queue is empty', async () => {
    const { repository } = createMockRepository();
    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(false);
  });

  it('releases or fails claim when simulated agent throws an error', async () => {
    const { repository, claimedEvents, releasedClaims, persistedDecisions } =
      createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const failingAgent: SimulatedDeceptionAgent = {
      async recordCommand() {
        throw new Error('Simulated deception agent internal error');
      },
    };

    const processor = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: failingAgent,
      logger: noopLogger,
    });

    await expect(processor.processNextPending()).rejects.toThrow(
      'Simulated deception agent internal error',
    );
    expect(persistedDecisions.length).toBe(0);
    expect(releasedClaims.length).toBe(1);
    expect(releasedClaims[0]?.eventId).toBe(mockDecoyEvent.id);
  });

  it('releases or fails claim when persistence throws', async () => {
    const { repository, claimedEvents, releasedClaims } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    vi.spyOn(repository, 'persistDecision').mockRejectedValueOnce(
      new Error('Simulated database crash'),
    );

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      simulatedAgent: defaultAgent,
      logger: noopLogger,
    });

    await expect(processor.processNextPending()).rejects.toThrow('Simulated database crash');
    expect(releasedClaims.length).toBe(1);
    expect(releasedClaims[0]?.eventId).toBe(mockDecoyEvent.id);
    expect(releasedClaims[0]?.claimToken).toBe(`claim-${mockDecoyEvent.id}`);
  });

  it('logs only safe claim context when persistence rejects with credential-bearing details', async () => {
    const { logger, rawLines } = createCapturingLogger();
    const { repository, claimedEvents, releasedClaims } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const databaseCredential = 'not-a-real-database-password';
    const bearerToken = 'dummy-not-a-real-bearer-token';
    const longDiagnostic = 'RAW_DATABASE_DIAGNOSTIC_'.repeat(80);
    const persistenceError = new Error(
      `Persistence failed\n` +
        `url=postgresql://dummy-user:${databaseCredential}@database.example.test/falseroute\n` +
        `Authorization: Bearer ${bearerToken}\n` +
        `diagnostic=${longDiagnostic}`,
    );
    vi.spyOn(repository, 'persistDecision').mockRejectedValueOnce(persistenceError);

    const processor = new EventProcessor({
      repository,
      geminiAdapter: new FakeGeminiAdapter('auto'),
      simulatedAgent: defaultAgent,
      logger,
    });

    await expect(processor.processNextPending()).rejects.toBe(persistenceError);

    expect(releasedClaims).toEqual([
      {
        eventId: mockDecoyEvent.id,
        claimToken: `claim-${mockDecoyEvent.id}`,
        outcome: 'FAILED',
      },
    ]);

    const failureLog = rawLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'Worker failed to complete processing for claimed event');
    expect(failureLog).toMatchObject({
      eventId: mockDecoyEvent.id,
      correlationId: mockDecoyEvent.correlationId,
      outcome: 'FAILED',
    });
    const combinedLogs = rawLines.join('\n');
    expect(combinedLogs).not.toContain(databaseCredential);
    expect(combinedLogs).not.toContain(bearerToken);
    expect(combinedLogs).not.toContain(longDiagnostic);
  });

  it('does not leak API keys, bearer tokens, prompts, or raw error messages into logs during adapter failure', async () => {
    const { logger, rawLines } = createCapturingLogger();
    const { repository, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const secretApiKey = 'dummy-not-a-real-provider-key';
    const secretBearerToken = 'not-a-real-bearer-token';
    const sensitivePrompt = 'CRITICAL_PROMPT_INSTRUCTION: classify this mock credential payload';
    const sensitiveUrl = 'https://dummy-user:not-a-real-pass@gemini.example.com/v1';
    const longResponse = 'VERY_LONG_RAW_RESPONSE_TEXT_'.repeat(50);

    const leakyError = new Error(
      `Adapter failure with apiKey=${secretApiKey}\n` +
        `Authorization: Bearer ${secretBearerToken}\n` +
        `prompt: "${sensitivePrompt}"\n` +
        `endpoint: ${sensitiveUrl}\n` +
        `response: ${longResponse}`,
    );

    const failingAdapter = {
      async enrichEvent(): Promise<never> {
        throw leakyError;
      },
    };

    const processor = new EventProcessor({
      repository,
      geminiAdapter: failingAdapter,
      simulatedAgent: defaultAgent,
      logger,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.decision?.modelEnrichment?.provenance).toBe('UNAVAILABLE');

    const combinedLogs = rawLines.join('\n');
    expect(combinedLogs).not.toContain(secretApiKey);
    expect(combinedLogs).not.toContain(secretBearerToken);
    expect(combinedLogs).not.toContain(sensitivePrompt);
    expect(combinedLogs).not.toContain(sensitiveUrl);
    expect(combinedLogs).not.toContain(longResponse);
    expect(combinedLogs).not.toContain('CRITICAL_PROMPT_INSTRUCTION');

    expect(combinedLogs).toContain('corr-proc-001');
    expect(combinedLogs).toContain(mockDecoyEvent.id);
  });

  it('routes Gemini model calls through GeminiBudgetService when configured', async () => {
    const { logger } = createCapturingLogger();
    const { repository, claimedEvents } = createMockRepository();
    claimedEvents.push(mockNonDecoyEvent);

    const mockEnrichmentAdapter = {
      enrichEvent: vi.fn().mockResolvedValue({
        reasoningSummary: 'Enriched reasoning summary',
        confidenceScore: 0.95,
        riskLevel: 'HIGH',
        observedIndicators: ['SUSPICIOUS_USER_AGENT'],
        suggestedStrategy: 'DIVERT_TO_HONEYPOT',
        fallbackStrategy: 'ASSIGN_FALSE_ROUTE',
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 },
      }),
    };

    const attemptGate = {
      beginAttempt: vi.fn().mockResolvedValue({ attemptNumber: 1, claimToken: 'owner-not-a-real' }),
    };
    const mockBudgetService = {
      executeWithBudget: vi.fn().mockImplementation(async (params) => {
        return params.execute(attemptGate);
      }),
    } as unknown as GeminiBudgetService;

    const processor = new EventProcessor({
      repository,
      geminiAdapter: mockEnrichmentAdapter,
      simulatedAgent: defaultAgent,
      logger,
      budgetService: mockBudgetService,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(true);
    expect(mockBudgetService.executeWithBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: mockNonDecoyEvent.id,
      }),
    );
    // The durable attempt gate must reach the adapter so internal retries stay accounted for.
    expect(mockEnrichmentAdapter.enrichEvent).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      attemptGate,
    );
  });
});
