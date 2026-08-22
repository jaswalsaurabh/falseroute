import { describe, expect, it, vi } from 'vitest';
import { type IntrusionEvent, type DeceptionDecision } from '@false-route/contracts';
import { createLogger } from '@false-route/observability';
import { Writable } from 'node:stream';
import { EventProcessor } from './event-processor.js';
import { FakeGeminiAdapter } from '../adapters/fake-gemini-adapter.js';
import { type WorkerRepository } from '../persistence/worker-repository.js';

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
  persistedDecisions: DeceptionDecision[];
  claimedEvents: IntrusionEvent[];
  failedEvents: string[];
} {
  const persistedDecisions: DeceptionDecision[] = [];
  const claimedEvents: IntrusionEvent[] = [];
  const failedEvents: string[] = [];

  const repository: WorkerRepository = {
    async claimNextPendingEvent() {
      return claimedEvents.shift() ?? null;
    },
    async persistDecision(decision: DeceptionDecision) {
      persistedDecisions.push(decision);
    },
    async markEventFailed(eventId: string) {
      failedEvents.push(eventId);
    },
  };

  return { repository, persistedDecisions, claimedEvents, failedEvents };
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
  it('processes decoy event and persists ASSIGN_FALSE_ROUTE decision', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
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
    expect(persistedDecisions[0]?.eventId).toBe(mockDecoyEvent.id);
  });

  it('processes non-decoy event without assigning false route', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockNonDecoyEvent);

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('OBSERVE');
    expect(persistedDecisions.length).toBe(1);
    expect(persistedDecisions[0]?.action).not.toBe('ASSIGN_FALSE_ROUTE');
  });

  it('completes deterministic decision when Gemini times out', async () => {
    const { repository, persistedDecisions, claimedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    const timeoutAdapter = new FakeGeminiAdapter('timeout');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: timeoutAdapter,
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
      logger: noopLogger,
    });

    const result = await processor.processNextPending();

    expect(result.processed).toBe(true);
    expect(result.decision?.action).toBe('OBSERVE');
    expect(persistedDecisions[0]?.action).not.toBe('ASSIGN_FALSE_ROUTE');
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
      logger: noopLogger,
    });

    const result = await processor.processNextPending();
    expect(result.processed).toBe(false);
  });

  it('marks event FAILED if persistence throws', async () => {
    const { repository, claimedEvents, failedEvents } = createMockRepository();
    claimedEvents.push(mockDecoyEvent);

    vi.spyOn(repository, 'persistDecision').mockRejectedValueOnce(
      new Error('Simulated database crash'),
    );

    const adapter = new FakeGeminiAdapter('auto');
    const processor = new EventProcessor({
      repository,
      geminiAdapter: adapter,
      logger: noopLogger,
    });

    await expect(processor.processNextPending()).rejects.toThrow('Simulated database crash');
    expect(failedEvents).toContain(mockDecoyEvent.id);
  });
});
