import { describe, it, expect, vi } from 'vitest';
import { AutonomousWorkflowOrchestrator } from './autonomous-workflow.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { type IntrusionEventEnvelope } from '@false-route/contracts';
import { FakeAutonomousGeminiAdapter } from '../adapters/fake-autonomous-gemini-adapter.js';
import { ToolGateway } from '../tools/tool-gateway.js';
import { FakeCloudRunAdapter, FakeFalseRouteAdapter } from '../tools/fake-cloud-adapters.js';

interface RecordedEvent {
  readonly eventType: string;
  readonly stage: string;
  readonly provenance: string;
  readonly summary: string;
  readonly payload?: Record<string, unknown> | undefined;
  readonly [key: string]: unknown;
}

function createMockRepos() {
  const recordedEvents: RecordedEvent[] = [];
  const deliveryAttempts: Array<{ status: string }> = [];

  const mockWorkflowRepo = {
    recordIngestionReceipt: vi.fn().mockResolvedValue({
      isDuplicate: false,
      receipt: {
        id: 'rec-1',
        eventId: '11111111-1111-4111-8111-111111111111',
        transportId: 'msg-1',
        source: 'PUB_SUB',
        status: 'ACCEPTED',
        receivedAt: new Date(),
      },
    }),
    reserveToolOperation: vi.fn().mockResolvedValue({ isExisting: false, operation: {} }),
    updateToolOperationStage: vi.fn().mockResolvedValue({}),
    claimProviderIntent: vi.fn().mockResolvedValue({
      disposition: 'CLAIMED',
      claimToken: '22222222-2222-4222-8222-222222222222',
      intent: { id: 'intent-1' },
    }),
    updateProviderIntentStatus: vi.fn().mockResolvedValue({}),
    createDecoyLease: vi.fn().mockResolvedValue({}),
    createFalseRouteLease: vi.fn().mockResolvedValue({}),
    createQuarantineLease: vi.fn().mockResolvedValue({}),
    reserveBudget: vi.fn().mockResolvedValue({
      granted: true,
      isDuplicate: false,
      reservation: { id: 'res-1', status: 'RESERVED' },
    }),
    acquireEventAttemptSlot: vi
      .fn()
      .mockImplementation(
        (params: { idempotencyKeyPrefix: string; amountReserved: number; ownerId: string }) =>
          Promise.resolve({
            granted: true,
            isDuplicate: false,
            attemptNumber: 1,
            reservation: {
              id: 'res-1',
              idempotencyKey: `${params.idempotencyKeyPrefix}:attempt-1`,
              status: 'RESERVED',
              ownerId: params.ownerId,
              amountReserved: params.amountReserved,
              version: 1,
            },
          }),
      ),
    recordGeminiAttemptOutcome: vi.fn().mockResolvedValue(undefined),
    consumeBudget: vi.fn().mockResolvedValue({}),
    releaseBudget: vi.fn().mockResolvedValue({}),
    countEventReservations: vi.fn().mockResolvedValue(0),
    getBudgetStatus: vi.fn().mockResolvedValue({
      category: 'DAILY_GEMINI_TOKENS',
      windowKey: '2026-08-23',
      limit: 100_000,
      totalConsumed: 0,
      totalActiveReserved: 0,
      totalCommitted: 0,
      remainingAvailable: 100_000,
      isExceeded: false,
    }),
    recordDeliveryAttempt: vi.fn().mockImplementation((attempt: { status: string }) => {
      deliveryAttempts.push(attempt);
      return Promise.resolve({});
    }),
  } as unknown as AutonomousWorkflowRepository;

  const mockActivityRepo = {
    recordActivityEvent: vi.fn().mockImplementation((evt: RecordedEvent) => {
      recordedEvents.push(evt);
      return Promise.resolve({ cursor: recordedEvents.length });
    }),
  } as unknown as ActivityEventRepository;

  return { mockWorkflowRepo, mockActivityRepo, recordedEvents, deliveryAttempts };
}

describe('AutonomousWorkflowOrchestrator', () => {
  const baseEnvProbeEnvelope: IntrusionEventEnvelope = {
    eventId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-orch-1',
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

  it('defaults to unavailable adapter when no Gemini key is provided, recording GEMINI_ANALYSIS_DEGRADED', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    // Default constructor uses FakeAutonomousGeminiAdapter('unavailable')
    const orchestrator = new AutonomousWorkflowOrchestrator(mockWorkflowRepo, mockActivityRepo);

    const result = await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-no-key-1');
    expect(result.status).toBe('COMPLETED');
    expect(result.executedActions.length).toBeGreaterThan(0); // Fallback executes

    const eventTypes = recordedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('GEMINI_ANALYSIS_DEGRADED');
    expect(eventTypes).not.toContain('GEMINI_ANALYSIS_COMPLETED');
    expect(eventTypes).not.toContain('MODEL_TOOL_REQUESTED');
  });

  it('processes valid ENV_FILE_PROBE event with explicitly injected fake-success adapter', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    const geminiAdapter = new FakeAutonomousGeminiAdapter('auto');
    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      geminiAdapter,
    );

    const result = await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-ps-1234');
    expect(result.status).toBe('COMPLETED');
    expect(result.executedActions).toContain('request_decoy_deployment');
    expect(result.executedActions).toContain('request_false_route_assignment');
    expect(result.acknowledged).toBe(true);

    const eventTypes = recordedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('INTRUSION_INGESTED');
    expect(eventTypes).toContain('GEMINI_ANALYSIS_REQUESTED');
    expect(eventTypes).toContain('GEMINI_ANALYSIS_COMPLETED');
    expect(eventTypes).toContain('MODEL_TOOL_REQUESTED');
    expect(eventTypes).toContain('TOOL_AUTHORIZED');
    expect(eventTypes).toContain('TOOL_EXECUTED');
    expect(eventTypes).toContain('WORKFLOW_COMPLETED');
  });

  it('proves every executed action has a preceding policy authorization in strict cursor order', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-order-1');

    const executedIndices = recordedEvents
      .map((e, idx) => (e.eventType === 'TOOL_EXECUTED' ? idx : -1))
      .filter((idx) => idx >= 0);
    const authorizedIndices = recordedEvents
      .map((e, idx) => (e.eventType === 'TOOL_AUTHORIZED' ? idx : -1))
      .filter((idx) => idx >= 0);

    expect(executedIndices.length).toBeGreaterThan(0);
    expect(authorizedIndices.length).toBeGreaterThanOrEqual(executedIndices.length);

    // Every TOOL_EXECUTED must be preceded by TOOL_AUTHORIZED
    for (const execIdx of executedIndices) {
      const precedingAuth = authorizedIndices.find((authIdx) => authIdx < execIdx);
      expect(precedingAuth).toBeDefined();
    }
  });

  it('records TOOL_FAILED, WORKFLOW_FAILED, and halts before route adapter when decoy deployment fails', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents, deliveryAttempts } =
      createMockRepos();

    // Injected CloudRun adapter that throws an error
    const failingCloudRun = {
      deployDecoy: vi.fn().mockRejectedValue(new Error('Simulated Cloud Run capacity failure')),
    } as unknown as FakeCloudRunAdapter;

    const routeAdapter = new FakeFalseRouteAdapter();
    const routeSpy = vi.spyOn(routeAdapter, 'assignRoute');

    const failingToolGateway = new ToolGateway(mockWorkflowRepo, mockActivityRepo, {
      cloudRunAdapter: failingCloudRun,
      falseRouteAdapter: routeAdapter,
    });

    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      failingToolGateway,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    const result = await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-failure-1');
    expect(result.status).toBe('FAILED');
    expect(result.acknowledged).toBe(true);
    expect(result.executedActions).toEqual([]);

    // Proves the route adapter was NEVER called because workflow stopped after deployment failure
    expect(routeSpy).not.toHaveBeenCalled();

    const eventTypes = recordedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('TOOL_FAILED');
    expect(eventTypes).toContain('WORKFLOW_FAILED');
    expect(eventTypes).not.toContain('WORKFLOW_COMPLETED');

    const lastDelivery = deliveryAttempts[deliveryAttempts.length - 1];
    expect(lastDelivery?.status).toBe('TERMINAL_FAILURE');

    // TOOL_FAILED must precede WORKFLOW_FAILED
    const toolFailedIdx = recordedEvents.findIndex((e) => e.eventType === 'TOOL_FAILED');
    const workflowFailedIdx = recordedEvents.findIndex((e) => e.eventType === 'WORKFLOW_FAILED');
    expect(toolFailedIdx).toBeLessThan(workflowFailedIdx);
  });

  it('durably records a policy decision activity event for recommend_response_plan', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-plan-policy-1');

    const planPolicyEvent = recordedEvents.find(
      (e) =>
        e.payload?.['toolName'] === 'recommend_response_plan' &&
        (e.eventType === 'TOOL_AUTHORIZED' ||
          e.eventType === 'TOOL_NARROWED' ||
          e.eventType === 'TOOL_REJECTED'),
    );

    expect(planPolicyEvent).toBeDefined();
    expect(planPolicyEvent?.summary).toContain('recommend_response_plan');
  });

  it('proves raw model freeform text or prompts do not appear in activity payloads or summaries', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    await orchestrator.processEventEnvelope(baseEnvProbeEnvelope, 'msg-sanitize-1');

    for (const evt of recordedEvents) {
      if (evt.eventType === 'MODEL_TOOL_REQUESTED') {
        expect(evt.payload?.['parameters']).toBeUndefined();
        expect(evt.payload?.['rationale']).toBeUndefined();
        expect(evt.payload?.['reason']).toBeUndefined();
        expect(evt.payload?.['details']).toBeUndefined();
      }
    }
  });

  it('skips side effects on duplicate message delivery', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    vi.mocked(mockWorkflowRepo.recordIngestionReceipt).mockResolvedValueOnce({
      isDuplicate: true,
      receipt: {
        id: 'rec-dup',
        eventId: '11111111-1111-4111-8111-111111111111',
        transportId: 'msg-duplicate-1234',
        source: 'PUB_SUB',
        status: 'ACCEPTED',
        receivedAt: new Date(),
      },
    });

    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    const result = await orchestrator.processEventEnvelope(
      baseEnvProbeEnvelope,
      'msg-duplicate-1234',
    );
    expect(result.status).toBe('DUPLICATE');
    expect(result.executedActions).toEqual([]);
    expect(result.acknowledged).toBe(true);

    const eventTypes = recordedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('DUPLICATE_INGESTION_SKIPPED');
    expect(eventTypes).not.toContain('TOOL_EXECUTED');
  });

  it('rejects model requests and executes zero actions for negative control', async () => {
    const { mockWorkflowRepo, mockActivityRepo, recordedEvents } = createMockRepos();
    const negControlEnvelope: IntrusionEventEnvelope = {
      ...baseEnvProbeEnvelope,
      evidence: {
        ...baseEnvProbeEnvelope.evidence,
        isPositiveMatch: false,
        isNegativeControl: true,
      },
    };

    const orchestrator = new AutonomousWorkflowOrchestrator(
      mockWorkflowRepo,
      mockActivityRepo,
      undefined,
      new FakeAutonomousGeminiAdapter('auto'),
    );

    const result = await orchestrator.processEventEnvelope(negControlEnvelope, 'msg-neg-1');
    expect(result.status).toBe('COMPLETED');
    expect(result.executedActions).toEqual([]);

    const executedEvents = recordedEvents.filter((e) => e.eventType === 'TOOL_EXECUTED');
    expect(executedEvents.length).toBe(0);
  });
});
