import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolGateway } from './tool-gateway.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { FakeCloudRunAdapter, FakeFalseRouteAdapter } from './fake-cloud-adapters.js';

describe('ToolGateway', () => {
  let mockWorkflowRepo: AutonomousWorkflowRepository;
  let mockActivityRepo: ActivityEventRepository;
  let gateway: ToolGateway;

  beforeEach(() => {
    mockWorkflowRepo = {
      reserveToolOperation: vi.fn().mockResolvedValue({
        isExisting: false,
        operation: { id: 'op-1', stage: 'AUTHORIZED' },
      }),
      updateToolOperationStage: vi.fn().mockResolvedValue({}),
      claimProviderIntent: vi.fn().mockResolvedValue({
        disposition: 'CLAIMED',
        claimToken: '22222222-2222-4222-8222-222222222222',
        intent: { id: 'intent-1' },
      }),
      updateProviderIntentStatus: vi.fn().mockResolvedValue({}),
      createDecoyLease: vi.fn().mockResolvedValue({ id: 'lease-1' }),
      createFalseRouteLease: vi.fn().mockResolvedValue({ id: 'lease-2' }),
      createQuarantineLease: vi.fn().mockResolvedValue({ id: 'lease-3' }),
      reserveBudget: vi.fn().mockResolvedValue({
        granted: true,
        isDuplicate: false,
        reservation: {
          id: 'res-1',
          idempotencyKey: 'budget:tool:1',
          category: 'HOURLY_TOOL_OPERATIONS',
          windowKey: '2026-08-23T09',
          amountReserved: 1,
          status: 'RESERVED',
          ownerId: 'worker-1',
          expiresAt: new Date(),
        },
      }),
      consumeBudget: vi.fn().mockResolvedValue({}),
      releaseBudget: vi.fn().mockResolvedValue({}),
      getProviderIntent: vi.fn().mockResolvedValue(null),
      getToolBudgetReservation: vi.fn().mockResolvedValue(null),
      settleAmbiguousToolReservation: vi
        .fn()
        .mockResolvedValue({ settled: true, reason: 'RECONCILE' }),
      getBudgetStatus: vi.fn().mockResolvedValue({
        category: 'DAILY_USD',
        windowKey: '2026-08-23',
        limit: 10.0,
        totalConsumed: 0,
        totalActiveReserved: 0,
        totalCommitted: 0,
        remainingAvailable: 10.0,
        isExceeded: false,
      }),
    } as unknown as AutonomousWorkflowRepository;

    mockActivityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;

    gateway = new ToolGateway(mockWorkflowRepo, mockActivityRepo);
  });

  it('authorizes decoy deployment for ENV_FILE_PROBE and executes simulated deploy', async () => {
    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing .env containment',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-test-1',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(true);
    expect(result.stage).toBe('FAKE_EXECUTED');
    expect(result.providerResourceId).toContain('cr-mock-admin-decoy');
    expect(mockWorkflowRepo.claimProviderIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'request_decoy_deployment',
        provider: 'CLOUD_RUN',
      }),
    );
  });

  it('rejects quarantine request for configuration probe scenario', async () => {
    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-2',
        toolName: 'request_source_quarantine',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          sourceIp: '198.51.100.25',
          cidrPrefix: 32,
          ttlSeconds: 300,
          reason: 'Premature quarantine attempt',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-test-2',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(false);
    expect(result.stage).toBe('REJECTED');
  });

  it('rejects negative control evidence from executing containment actions', async () => {
    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-neg-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing negative control',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-test-neg',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: false,
        isNegativeControl: true,
      },
    );

    expect(result.authorized).toBe(false);
    expect(result.stage).toBe('REJECTED');
    expect(result.policyReason).toContain('Negative control evidence rejected');
  });

  it('authorizes quarantine request for SUSPICIOUS_IP_BURST', async () => {
    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-3',
        toolName: 'request_source_quarantine',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          sourceIp: '198.51.100.27',
          cidrPrefix: 32,
          ttlSeconds: 600,
          reason: 'Volumetric burst response',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-test-3',
        scenarioKind: 'SUSPICIOUS_IP_BURST',
        sourceIp: '198.51.100.27',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(true);
    expect(result.stage).toBe('FAKE_EXECUTED');
    expect(mockWorkflowRepo.claimProviderIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'request_source_quarantine',
        provider: 'CLOUD_ARMOR',
      }),
    );
  });

  it('persists only bounded application failure category without raw diagnostics on adapter error', async () => {
    const failingGateway = new ToolGateway(mockWorkflowRepo, mockActivityRepo, {
      cloudRunAdapter: {
        deployDecoy: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Sensitive DB url: postgresql://not-a-real-user:not-a-real-password@example.invalid:5432/not-a-real-db',
            ),
          ),
      } as unknown as FakeCloudRunAdapter,
    });

    const result = await failingGateway.executeToolCall(
      {
        toolCallId: 'call-fail-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing failure sanitization',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-fail-test',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toBe('Simulated adapter execution failure');

    expect(mockWorkflowRepo.updateProviderIntentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        result: {
          error: 'Simulated adapter execution failure',
          failureCategory: 'ADAPTER_EXECUTION_FAILURE',
        },
      }),
    );

    expect(mockActivityRepo.recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TOOL_FAILED',
        payload: {
          toolName: 'request_decoy_deployment',
          error: 'Simulated adapter execution failure',
        },
      }),
    );
  });

  it('handles existing terminal REJECTED ledger reservation idempotently', async () => {
    vi.mocked(mockWorkflowRepo.reserveToolOperation).mockResolvedValueOnce({
      isExisting: true,
      operation: {
        id: 'op-rejected',
        idempotencyKey: 'idem-rejected',
        eventId: '11111111-1111-4111-8111-111111111111',
        toolName: 'request_decoy_deployment',
        inputHash: 'hash-rejected-1',
        stage: 'REJECTED',
        authorized: false,
        policyReason: 'Policy violation: unauthorized target',
      },
    });

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-rejected-replay',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Replaying rejected op',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-replay-rej',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('REJECTED');
    expect(result.authorized).toBe(false);
    expect(result.policyReason).toBe('Policy violation: unauthorized target');
    expect(mockWorkflowRepo.claimProviderIntent).not.toHaveBeenCalled();
  });

  it('rejects tool call when durable hourly tool operation budget is exceeded', async () => {
    vi.mocked(mockWorkflowRepo.reserveBudget).mockResolvedValueOnce({
      granted: false,
      isDuplicate: false,
      reason: 'Durable budget ceiling exceeded for category HOURLY_TOOL_OPERATIONS',
      currentCommitted: 50,
      limit: 50,
    });

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-budget-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing budget limit',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-budget-test',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(false);
    expect(result.stage).toBe('REJECTED');
    expect(result.policyReason).toContain('Durable budget ceiling exceeded');
  });

  it('rejects tool call and releases hourly tool budget when daily USD budget is exceeded', async () => {
    vi.mocked(mockWorkflowRepo.reserveBudget)
      .mockResolvedValueOnce({
        granted: true,
        isDuplicate: false,
        reservation: {
          id: 'res-tool',
          idempotencyKey: 'budget:tool:2',
          category: 'HOURLY_TOOL_OPERATIONS',
          windowKey: '2026-08-23T09',
          amountReserved: 1,
          status: 'RESERVED',
          ownerId: 'worker-1',
          expiresAt: new Date(),
          version: 1,
        },
      })
      .mockResolvedValueOnce({
        granted: false,
        isDuplicate: false,
        reason: 'Durable budget ceiling exceeded for category DAILY_USD',
        currentCommitted: 9.8,
        limit: 10.0,
      });

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-budget-usd',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing USD budget limit',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-budget-usd',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(false);
    expect(result.stage).toBe('REJECTED');
    expect(result.policyReason).toContain('DAILY_USD');
    expect(mockWorkflowRepo.releaseBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringContaining('budget:tool:'),
      }),
    );
  });

  it('fails closed when durable budget repository throws an error', async () => {
    vi.mocked(mockWorkflowRepo.reserveBudget).mockRejectedValueOnce(
      new Error('PostgreSQL connection timeout'),
    );

    await expect(
      gateway.executeToolCall(
        {
          toolCallId: 'call-budget-err',
          toolName: 'request_decoy_deployment',
          parameters: {
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            region: 'us-central1',
            ttlSeconds: 300,
            reason: 'Testing fail closed on DB error',
          },
          requestedAt: new Date().toISOString(),
        },
        {
          eventId: '11111111-1111-4111-8111-111111111111',
          correlationId: 'corr-db-err',
          scenarioKind: 'ENV_FILE_PROBE',
          sourceIp: '198.51.100.25',
          isPositiveMatch: true,
          isNegativeControl: false,
        },
      ),
    ).rejects.toThrow('PostgreSQL connection timeout');
  });

  it('rejects tool call when reservation is held by another owner (granted: false, isDuplicate: true)', async () => {
    vi.mocked(mockWorkflowRepo.reserveBudget).mockResolvedValueOnce({
      granted: false,
      isDuplicate: true,
      reason: 'Reservation is actively held by another claim owner',
      currentCommitted: 50,
      limit: 50,
    });

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-another-owner',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing another owner rejection',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-owner-test',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.authorized).toBe(false);
    expect(result.stage).toBe('REJECTED');
    expect(result.policyReason).toContain('actively held by another claim owner');
    expect(mockWorkflowRepo.claimProviderIntent).not.toHaveBeenCalled();
  });

  it('returns stage FAILED and does not release budget when provider intent persistence fails after provider success', async () => {
    vi.mocked(mockWorkflowRepo.updateProviderIntentStatus).mockRejectedValueOnce(
      new Error('Provider intent write collision'),
    );

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-intent-fail',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing intent persistence failure',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-intent-fail',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toContain('reconciliation required');
    expect(mockWorkflowRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it('returns stage FAILED and does not release budget when lease persistence fails after provider success', async () => {
    vi.mocked(mockWorkflowRepo.createDecoyLease).mockRejectedValueOnce(
      new Error('Lease DB write failed'),
    );

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-lease-fail',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing lease persistence failure',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-lease-fail',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toContain('reconciliation required');
    expect(mockWorkflowRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it('returns stage FAILED and preserves reservation when budget consumption fails after provider success', async () => {
    vi.mocked(mockWorkflowRepo.consumeBudget).mockRejectedValueOnce(
      new Error('Budget consumption timeout'),
    );

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-consume-fail',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing consume failure',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-consume-fail',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toContain('reconciliation required');
    expect(mockWorkflowRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it('returns stage FAILED when tool ledger persistence fails after provider success', async () => {
    vi.mocked(mockWorkflowRepo.updateToolOperationStage).mockRejectedValueOnce(
      new Error('Tool ledger stage write error'),
    );

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-ledger-fail',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Testing ledger failure',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-ledger-fail',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toContain('reconciliation required');
    expect(mockWorkflowRepo.releaseBudget).not.toHaveBeenCalled();
  });

  it('reconciles and completes missing projections on retry of a previously failed operation', async () => {
    // 1. Initial execution failed during lease write after provider success
    const fakeCloudRun = new FakeCloudRunAdapter();
    const reconGateway = new ToolGateway(mockWorkflowRepo, mockActivityRepo, {
      cloudRunAdapter: fakeCloudRun,
      workerId: 'worker-recon-1',
      clock: () => new Date('2026-08-23T10:00:00Z'),
    });

    // Deploy decoy to provider
    await fakeCloudRun.deployDecoy({
      templateName: 'mock-admin-decoy',
      region: 'us-central1',
      ttlSeconds: 300,
      operationKey: 'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
    });

    // Tool reservation is existing in FAILED stage
    vi.mocked(mockWorkflowRepo.reserveToolOperation).mockResolvedValueOnce({
      isExisting: true,
      operation: {
        id: 'op-1',
        idempotencyKey: 'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
        eventId: '11111111-1111-4111-8111-111111111111',
        toolName: 'request_decoy_deployment',
        inputHash: 'hash-recon-1',
        stage: 'FAILED',
        authorized: true,
        policyReason: 'Ambiguous outcome',
        providerResourceId: 'decoy-recon-test',
        observedState: 'UNKNOWN',
      },
    });

    // Provider intent is pending reconciliation
    vi.mocked(mockWorkflowRepo.claimProviderIntent).mockResolvedValueOnce({
      disposition: 'RECONCILIATION_REQUIRED',
      intent: {
        id: 'intent-1',
        idempotencyKey: 'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
        eventId: '11111111-1111-4111-8111-111111111111',
        operationType: 'request_decoy_deployment',
        provider: 'CLOUD_RUN',
        status: 'PENDING',
        result: null,
        claimOwner: null,
        claimExpiresAt: null,
        version: 1,
      },
    });

    const result = await reconGateway.executeToolCall(
      {
        toolCallId: 'call-retry-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Retrying failed operation',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-retry-test',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAKE_EXECUTED');
    expect(result.policyReason).toContain('Reconciled and recovered provider resource');
    expect(mockWorkflowRepo.updateProviderIntentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'EXECUTED',
        reconciliationClaim: expect.objectContaining({
          expectedStatus: 'PENDING',
          expectedVersion: 1,
        }),
      }),
    );
    expect(mockWorkflowRepo.createDecoyLease).toHaveBeenCalled();
    expect(mockWorkflowRepo.consumeBudget).toHaveBeenCalled();
    expect(mockWorkflowRepo.updateToolOperationStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'FAKE_EXECUTED',
        observedState: 'READY',
      }),
    );
  });

  it('rejects reconciliation attempt when active unexpired claim is held by another worker', async () => {
    const fakeCloudRun = new FakeCloudRunAdapter();
    const competingGateway = new ToolGateway(mockWorkflowRepo, mockActivityRepo, {
      cloudRunAdapter: fakeCloudRun,
      workerId: 'worker-impostor-2',
      clock: () => new Date('2026-08-23T10:00:00Z'),
    });

    // Intent is currently claimed by worker-primary until 10:01:00Z
    vi.mocked(mockWorkflowRepo.claimProviderIntent).mockResolvedValueOnce({
      disposition: 'RECONCILIATION_REQUIRED',
      claimToken: '00000000-0000-4000-8000-000000000001',
      intent: {
        id: 'intent-active',
        idempotencyKey: 'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
        eventId: '11111111-1111-4111-8111-111111111111',
        operationType: 'request_decoy_deployment',
        provider: 'CLOUD_RUN',
        status: 'CLAIMED',
        result: null,
        claimOwner: 'worker-primary-1',
        claimExpiresAt: new Date('2026-08-23T10:01:00Z'),
        version: 1,
      },
    });

    const result = await competingGateway.executeToolCall(
      {
        toolCallId: 'call-competing-1',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Competing worker attempting reconciliation',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-competing-test',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(result.policyReason).toContain(
      'Active provider intent claim is currently held by another worker',
    );
    expect(mockWorkflowRepo.updateProviderIntentStatus).not.toHaveBeenCalled();
    expect(mockWorkflowRepo.updateToolOperationStage).not.toHaveBeenCalled();
  });
});

/**
 * Deterministic in-memory stand-in for the durable repository. It mirrors the real ledger, provider
 * intent, budget, and lease semantics (including CAS fences and owner checks) so that restart and
 * repair behaviour can be exercised across two separate ToolGateway instances. The durable CAS and
 * fencing guarantees themselves are proven against real PostgreSQL in
 * `packages/database/src/autonomous-workflow-repository.integration.test.ts`.
 */
class DurableFake {
  readonly ledger = new Map<string, Record<string, unknown>>();
  readonly intents = new Map<string, Record<string, unknown>>();
  readonly budgets = new Map<string, Record<string, unknown>>();
  readonly leases = new Map<string, Record<string, unknown>>();
  readonly activity: Record<string, unknown>[] = [];
  readonly failOnce = new Set<string>();
  private claimSeq = 0;

  private trip(marker: string): void {
    if (this.failOnce.delete(marker)) {
      throw new Error(`Injected durable failure at ${marker}`);
    }
  }

  async reserveToolOperation(p: {
    idempotencyKey: string;
    eventId: string;
    toolName: string;
    authorized: boolean;
    policyReason: string;
    initialStage?: string;
  }) {
    const existing = this.ledger.get(p.idempotencyKey);
    if (existing) return { isExisting: true, operation: existing };
    const created = {
      id: `op-${p.idempotencyKey}`,
      idempotencyKey: p.idempotencyKey,
      eventId: p.eventId,
      toolName: p.toolName,
      inputHash: 'hash-fake',
      stage: p.initialStage ?? 'AUTHORIZED',
      authorized: p.authorized,
      policyReason: p.policyReason,
      providerResourceId: null as string | null,
      observedState: null as string | null,
      details: {} as Record<string, unknown>,
    };
    this.ledger.set(p.idempotencyKey, created);
    return { isExisting: false, operation: created };
  }

  async updateToolOperationStage(p: {
    idempotencyKey: string;
    stage: string;
    expectedPriorStage?: string | readonly string[];
    providerResourceId?: string;
    observedState?: string;
    details?: Record<string, unknown>;
  }) {
    this.trip(`ledger:${p.stage}`);
    const row = this.ledger.get(p.idempotencyKey);
    if (!row) throw new Error('Tool-operation stage changed concurrently');
    const allowed =
      p.expectedPriorStage === undefined
        ? [row['stage'] as string]
        : Array.isArray(p.expectedPriorStage)
          ? [...p.expectedPriorStage]
          : [p.expectedPriorStage as string];
    if (!allowed.includes(row['stage'] as string)) {
      throw new Error('Tool-operation stage changed concurrently');
    }
    row['stage'] = p.stage;
    if (p.providerResourceId !== undefined) row['providerResourceId'] = p.providerResourceId;
    if (p.observedState !== undefined) row['observedState'] = p.observedState;
    if (p.details !== undefined) row['details'] = p.details;
    return row;
  }

  async claimProviderIntent(p: {
    idempotencyKey: string;
    eventId: string;
    operationType: string;
    provider: string;
    claimOwner: string;
    claimTtlMs?: number;
  }) {
    let intent = this.intents.get(p.idempotencyKey);
    if (!intent) {
      intent = {
        idempotencyKey: p.idempotencyKey,
        eventId: p.eventId,
        operationType: p.operationType,
        provider: p.provider,
        status: 'PENDING',
        result: null,
        version: 1,
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
      };
      this.intents.set(p.idempotencyKey, intent);
    }
    if (intent['status'] === 'EXECUTED') return { disposition: 'ALREADY_EXECUTED', intent };
    if (intent['status'] !== 'PENDING') return { disposition: 'RECONCILIATION_REQUIRED', intent };
    this.claimSeq += 1;
    const claimToken = `00000000-0000-4000-8000-${String(this.claimSeq).padStart(12, '0')}`;
    intent['status'] = 'CLAIMED';
    intent['claimOwner'] = p.claimOwner;
    intent['claimToken'] = claimToken;
    intent['claimExpiresAt'] = new Date(Date.now() + (p.claimTtlMs ?? 60_000));
    intent['version'] = (intent['version'] as number) + 1;
    return { disposition: 'CLAIMED', claimToken, intent };
  }

  async getProviderIntent(idempotencyKey: string) {
    return this.intents.get(idempotencyKey) ?? null;
  }

  async updateProviderIntentStatus(p: {
    idempotencyKey: string;
    claimToken?: string;
    reconciliationClaim?: {
      expectedStatus: 'PENDING' | 'CLAIMED';
      expectedVersion?: number;
      expectedOwner?: string;
      requireExpired?: boolean;
      asOf?: Date;
    };
    status: 'EXECUTED' | 'FAILED';
    result?: Record<string, unknown>;
  }) {
    this.trip('intent');
    if (!p.claimToken && !p.reconciliationClaim) {
      throw new Error(
        'updateProviderIntentStatus requires either a claimToken or an explicit reconciliationClaim',
      );
    }
    if (p.claimToken === undefined) {
      const rc = p.reconciliationClaim!;
      if (rc.expectedStatus === 'CLAIMED' && rc.requireExpired !== true) {
        throw new Error(
          'Provider-intent claim was lost: reconciling a CLAIMED intent requires the original claim token or an expired claim',
        );
      }
      if (rc.expectedVersion === undefined) {
        throw new Error(
          'Provider-intent claim was lost: reconciliation requires an expected version fence',
        );
      }
    }
    const intent = this.intents.get(p.idempotencyKey);
    if (!intent) throw new Error('Provider-intent claim was lost');
    if (p.claimToken !== undefined) {
      if (intent['status'] !== 'CLAIMED' || intent['claimToken'] !== p.claimToken) {
        throw new Error('Provider-intent claim was lost');
      }
    } else {
      const rc = p.reconciliationClaim!;
      const expiresAt = intent['claimExpiresAt'] as Date | null;
      if (
        intent['status'] !== rc.expectedStatus ||
        intent['version'] !== rc.expectedVersion ||
        (rc.expectedOwner !== undefined && intent['claimOwner'] !== rc.expectedOwner) ||
        (rc.requireExpired === true && !(expiresAt && expiresAt <= (rc.asOf ?? new Date())))
      ) {
        throw new Error('Provider-intent claim was lost');
      }
    }
    intent['status'] = p.status;
    if (p.result !== undefined) intent['result'] = p.result;
    intent['claimExpiresAt'] = null;
    intent['version'] = (intent['version'] as number) + 1;
    return intent;
  }

  async reserveBudget(p: {
    idempotencyKey: string;
    category: string;
    windowKey: string;
    amountReserved: number;
    limit: number;
    ownerId: string;
    eventId?: string;
  }) {
    const existing = this.budgets.get(p.idempotencyKey);
    if (existing) {
      if (existing['status'] !== 'RESERVED') {
        return {
          granted: false,
          isDuplicate: true,
          reason: `Reservation ${p.idempotencyKey} is in terminal status ${existing['status']}`,
          currentCommitted: p.limit,
          limit: p.limit,
        };
      }
      if (existing['ownerId'] !== p.ownerId) {
        return {
          granted: false,
          isDuplicate: true,
          reason: `Reservation ${p.idempotencyKey} is actively held by another claim owner`,
          currentCommitted: p.limit,
          limit: p.limit,
        };
      }
      return { granted: true, isDuplicate: true, reservation: existing };
    }
    const created = {
      idempotencyKey: p.idempotencyKey,
      category: p.category,
      windowKey: p.windowKey,
      amountReserved: p.amountReserved,
      amountConsumed: null as number | null,
      status: 'RESERVED',
      ownerId: p.ownerId,
      version: 1,
      expiresAt: new Date(Date.now() + 60_000),
      eventId: p.eventId ?? null,
    };
    this.budgets.set(p.idempotencyKey, created);
    return { granted: true, isDuplicate: false, reservation: created };
  }

  async consumeBudget(p: { idempotencyKey: string; ownerId: string; amountConsumed: number }) {
    this.trip('consume');
    const row = this.budgets.get(p.idempotencyKey);
    if (!row) throw new Error(`Budget reservation ${p.idempotencyKey} not found`);
    if (row['ownerId'] !== p.ownerId) {
      throw new Error(
        `Stale reservation owner: expected ${p.ownerId} but found ${row['ownerId'] as string}`,
      );
    }
    if (row['status'] !== 'RESERVED') {
      throw new Error(`Invalid reservation status: found ${row['status'] as string}`);
    }
    row['status'] = 'CONSUMED';
    row['amountConsumed'] = p.amountConsumed;
    row['version'] = (row['version'] as number) + 1;
    return row;
  }

  async releaseBudget(p: { idempotencyKey: string; ownerId: string }) {
    const row = this.budgets.get(p.idempotencyKey);
    if (!row) throw new Error(`Budget reservation ${p.idempotencyKey} not found`);
    if (row['ownerId'] !== p.ownerId) throw new Error('Stale reservation owner');
    if (row['status'] !== 'RESERVED') throw new Error('Invalid reservation status');
    row['status'] = 'RELEASED';
    row['version'] = (row['version'] as number) + 1;
    return row;
  }

  async getToolBudgetReservation(idempotencyKey: string) {
    return this.budgets.get(idempotencyKey) ?? null;
  }

  async settleAmbiguousToolReservation(p: {
    reservationKey: string;
    toolOperationKey: string;
    providerIntentKey: string;
    expectedOwnerId: string;
    expectedVersion: number;
    settlement: 'RECONCILE' | 'RELEASE';
  }) {
    if (
      p.providerIntentKey !== p.toolOperationKey ||
      (p.reservationKey !== `budget:tool:${p.toolOperationKey}` &&
        p.reservationKey !== `budget:usd:${p.toolOperationKey}`)
    ) {
      return { settled: false, reason: 'PROVIDER_INTENT_IDENTITY_MISMATCH' };
    }
    const row = this.budgets.get(p.reservationKey);
    if (!row) return { settled: false, reason: 'RESERVATION_NOT_FOUND' };
    if (row['status'] === 'CONSUMED' || row['status'] === 'RECONCILED') {
      return { settled: true, reason: 'ALREADY_SETTLED' };
    }
    if (row['status'] !== 'RESERVED') {
      return { settled: false, reason: `RESERVATION_STATUS_${row['status'] as string}` };
    }
    if (row['ownerId'] !== p.expectedOwnerId) {
      return { settled: false, reason: 'STALE_RESERVATION_OWNER' };
    }
    if (row['version'] !== p.expectedVersion) {
      return { settled: false, reason: 'STALE_RESERVATION_VERSION' };
    }
    const intent = this.intents.get(p.providerIntentKey);
    const required = p.settlement === 'RECONCILE' ? 'EXECUTED' : 'FAILED';
    if (!intent || intent['status'] !== required) {
      return { settled: false, reason: `PROVIDER_INTENT_NOT_${required}` };
    }
    const op = this.ledger.get(p.toolOperationKey);
    if (!op) return { settled: false, reason: 'TOOL_OPERATION_NOT_FOUND' };
    if (op['stage'] !== 'AUTHORIZED' && op['stage'] !== 'FAILED') {
      return { settled: false, reason: `TOOL_OPERATION_NOT_AMBIGUOUS_${op['stage'] as string}` };
    }
    if (op['eventId'] !== intent['eventId'] || op['toolName'] !== intent['operationType']) {
      return { settled: false, reason: 'PROVIDER_INTENT_IDENTITY_MISMATCH' };
    }
    row['status'] = p.settlement === 'RECONCILE' ? 'RECONCILED' : 'RELEASED';
    if (p.settlement === 'RECONCILE') row['amountConsumed'] = row['amountReserved'];
    row['version'] = (row['version'] as number) + 1;
    return { settled: true, reason: p.settlement };
  }

  private async createLease(ownershipKey: string, data: Record<string, unknown>) {
    this.trip('lease');
    const existing = this.leases.get(ownershipKey);
    if (existing) return existing;
    const created = { id: `lease-${this.leases.size + 1}`, ownershipKey, ...data };
    this.leases.set(ownershipKey, created);
    return created;
  }

  async createDecoyLease(p: { eventId: string; templateName: string }) {
    return this.createLease(`decoy:${p.eventId}:${p.templateName}`, { ...p });
  }

  async createFalseRouteLease(p: { eventId: string; sourceIp: string }) {
    return this.createLease(`route:${p.eventId}:${p.sourceIp}`, { ...p });
  }

  async createQuarantineLease(p: { eventId: string; sourceCidr: string }) {
    return this.createLease(`quarantine:${p.eventId}:${p.sourceCidr}`, { ...p });
  }

  activityRepo(): ActivityEventRepository {
    return {
      recordActivityEvent: async (params: Record<string, unknown>) => {
        this.trip('activity');
        this.activity.push(params);
        return { cursor: this.activity.length };
      },
    } as unknown as ActivityEventRepository;
  }

  workflowRepo(): AutonomousWorkflowRepository {
    return this as unknown as AutonomousWorkflowRepository;
  }
}

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const DECOY_KEY = `idem-request_decoy_deployment-${EVENT_ID}`;

const decoyCall = {
  toolCallId: 'call-durable-1',
  toolName: 'request_decoy_deployment' as const,
  parameters: {
    eventId: EVENT_ID,
    templateName: 'mock-admin-decoy',
    region: 'us-central1',
    ttlSeconds: 300,
    reason: 'Durable boundary coverage',
  },
  requestedAt: '2026-08-23T10:00:00.000Z',
};

const decoyContext = {
  eventId: EVENT_ID,
  correlationId: 'corr-durable-1',
  scenarioKind: 'ENV_FILE_PROBE' as const,
  sourceIp: '198.51.100.25',
  isPositiveMatch: true,
  isNegativeControl: false,
};

const routeCall = {
  toolCallId: 'call-durable-route',
  toolName: 'request_false_route_assignment' as const,
  parameters: {
    eventId: EVENT_ID,
    sourceIp: '198.51.100.25',
    targetDecoyService: 'mock-admin-decoy',
    ttlSeconds: 300,
    reason: 'Durable boundary coverage for route',
  },
  requestedAt: '2026-08-23T10:00:00.000Z',
};

function expectAllProjectionsDurable(fake: DurableFake): void {
  expect(fake.ledger.get(DECOY_KEY)?.['stage']).toBe('FAKE_EXECUTED');
  expect(fake.intents.get(DECOY_KEY)?.['status']).toBe('EXECUTED');
  expect(fake.leases.size).toBe(1);
  expect(['CONSUMED', 'RECONCILED']).toContain(
    fake.budgets.get(`budget:tool:${DECOY_KEY}`)?.['status'],
  );
  expect(['CONSUMED', 'RECONCILED']).toContain(
    fake.budgets.get(`budget:usd:${DECOY_KEY}`)?.['status'],
  );
  expect(fake.activity.some((a) => a['eventType'] === 'TOOL_EXECUTED')).toBe(true);
}

describe('ToolGateway durable boundary recovery', () => {
  let fake: DurableFake;
  let cloudRun: FakeCloudRunAdapter;
  let falseRoute: FakeFalseRouteAdapter;

  beforeEach(() => {
    fake = new DurableFake();
    cloudRun = new FakeCloudRunAdapter();
    falseRoute = new FakeFalseRouteAdapter();
  });

  function makeGateway(workerId: string): ToolGateway {
    return new ToolGateway(fake.workflowRepo(), fake.activityRepo(), {
      cloudRunAdapter: cloudRun,
      falseRouteAdapter: falseRoute,
      workerId,
    });
  }

  it('recovers a provider-success database-failure operation after a worker restart with a new worker id, without repeating the provider mutation', async () => {
    fake.failOnce.add('consume');
    const first = await makeGateway('worker-restart-a').executeToolCall(decoyCall, decoyContext);

    expect(first.stage).toBe('FAILED');
    expect(first.details?.['reconciliationRequired']).toBe(true);
    expect(cloudRun.deployCount).toBe(1);
    // The previous process left an unexpired RESERVED row it still owns; a fresh reservation by a
    // restarted worker would be refused, which is what used to make recovery unreachable.
    expect(fake.budgets.get(`budget:tool:${DECOY_KEY}`)?.['status']).toBe('RESERVED');
    expect(fake.budgets.get(`budget:tool:${DECOY_KEY}`)?.['ownerId']).toBe('worker-restart-a');

    const second = await makeGateway('worker-restart-b').executeToolCall(decoyCall, decoyContext);

    expect(second.stage).toBe('FAKE_EXECUTED');
    expect(cloudRun.deployCount).toBe(1);
    expect(fake.budgets.get(`budget:tool:${DECOY_KEY}`)?.['status']).toBe('RECONCILED');
    expect(fake.budgets.get(`budget:tool:${DECOY_KEY}`)?.['ownerId']).toBe('worker-restart-a');
    expectAllProjectionsDurable(fake);
  });

  it('does not reconcile another operation resource that shares the same natural provider key', async () => {
    const unrelated = await cloudRun.deployDecoy({
      templateName: 'mock-admin-decoy',
      region: 'us-central1',
      ttlSeconds: 300,
      operationKey: 'idem-request_decoy_deployment-unrelated-event',
    });
    await fake.reserveToolOperation({
      idempotencyKey: DECOY_KEY,
      eventId: EVENT_ID,
      toolName: 'request_decoy_deployment',
      authorized: true,
      policyReason: 'Prior operation awaiting recovery',
    });
    fake.intents.set(DECOY_KEY, {
      idempotencyKey: DECOY_KEY,
      eventId: EVENT_ID,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      status: 'PENDING',
      result: null,
      version: 1,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
    });

    const result = await makeGateway('worker-exact-identity').executeToolCall(
      decoyCall,
      decoyContext,
    );

    expect(result.stage).toBe('FAKE_EXECUTED');
    expect(result.providerResourceId).not.toBe(unrelated.serviceId);
    expect(cloudRun.deployCount).toBe(2);
  });

  it('recovers a false route assignment after restart without repeating the provider mutation', async () => {
    fake.failOnce.add('consume');
    const routeKey = `idem-request_false_route_assignment-${EVENT_ID}`;
    const first = await makeGateway('worker-route-a').executeToolCall(routeCall, {
      ...decoyContext,
      scenarioKind: 'DECOY_CREDENTIAL_USE',
    });
    expect(first.stage).toBe('FAILED');
    expect(falseRoute.assignCount).toBe(1);

    const second = await makeGateway('worker-route-b').executeToolCall(routeCall, {
      ...decoyContext,
      scenarioKind: 'DECOY_CREDENTIAL_USE',
    });
    expect(second.stage).toBe('FAKE_EXECUTED');
    expect(falseRoute.assignCount).toBe(1);
    expect(fake.ledger.get(routeKey)?.['stage']).toBe('FAKE_EXECUTED');
    expect(fake.budgets.get(`budget:tool:${routeKey}`)?.['status']).toBe('RECONCILED');
  });

  for (const boundary of [
    { marker: 'intent', label: 'provider intent write' },
    { marker: 'lease', label: 'lease write' },
    { marker: 'consume', label: 'budget settlement' },
    { marker: 'activity', label: 'activity projection write' },
    { marker: 'ledger:FAKE_EXECUTED', label: 'tool ledger write' },
  ] as const) {
    it(`keeps the operation non-terminal when the ${boundary.label} fails and repairs only the missing projection on retry`, async () => {
      const gateway = makeGateway('worker-boundary-1');
      fake.failOnce.add(boundary.marker);

      const first = await gateway.executeToolCall(decoyCall, decoyContext);
      expect(first.stage).toBe('FAILED');
      expect(first.details?.['reconciliationRequired']).toBe(true);
      expect(fake.ledger.get(DECOY_KEY)?.['stage']).not.toBe('FAKE_EXECUTED');
      expect(cloudRun.deployCount).toBe(1);

      const second = await gateway.executeToolCall(decoyCall, decoyContext);
      expect(second.stage).toBe('FAKE_EXECUTED');
      expect(cloudRun.deployCount).toBe(1);
      expectAllProjectionsDurable(fake);

      // A third attempt is an idempotent replay and still never re-mutates the provider.
      const third = await gateway.executeToolCall(decoyCall, decoyContext);
      expect(third.stage).toBe('FAKE_EXECUTED');
      expect(cloudRun.deployCount).toBe(1);
    });
  }

  it('lets only one of two concurrent calls sharing the same worker id settle the provider intent', async () => {
    const gateway = makeGateway('worker-same-id');

    const results = await Promise.all([
      gateway.executeToolCall(decoyCall, decoyContext),
      gateway.executeToolCall(decoyCall, decoyContext),
    ]);

    expect(results.filter((r) => r.stage === 'FAKE_EXECUTED')).toHaveLength(1);
    expect(results.filter((r) => r.stage === 'FAILED')).toHaveLength(1);
    expect(cloudRun.deployCount).toBe(1);
    expect(fake.intents.get(DECOY_KEY)?.['status']).toBe('EXECUTED');
  });

  it('lets only one of two concurrent calls from different worker ids settle the provider intent', async () => {
    const results = await Promise.all([
      makeGateway('worker-concurrent-a').executeToolCall(decoyCall, decoyContext),
      makeGateway('worker-concurrent-b').executeToolCall(decoyCall, decoyContext),
    ]);

    expect(results.filter((r) => r.stage === 'FAKE_EXECUTED')).toHaveLength(1);
    expect(cloudRun.deployCount).toBe(1);
    expect(fake.intents.get(DECOY_KEY)?.['status']).toBe('EXECUTED');
  });

  it('refuses to reconcile an active unexpired claim held under the same worker id', async () => {
    // A prior attempt in the same process crashed after the provider mutation, leaving an active
    // claim. A different gateway instance reusing that worker id must not take it over.
    fake.failOnce.add('intent');
    const first = await makeGateway('worker-shared-id').executeToolCall(decoyCall, decoyContext);
    expect(first.stage).toBe('FAILED');
    expect(cloudRun.deployCount).toBe(1);
    expect(fake.intents.get(DECOY_KEY)?.['status']).toBe('CLAIMED');

    const impostor = await makeGateway('worker-shared-id').executeToolCall(decoyCall, decoyContext);

    expect(impostor.stage).toBe('FAILED');
    expect(impostor.details?.['error']).toBe('ACTIVE_CLAIM_HELD');
    expect(fake.intents.get(DECOY_KEY)?.['status']).toBe('CLAIMED');
    expect(cloudRun.deployCount).toBe(1);
  });

  it('reconciles an expired claim from another worker without repeating the provider mutation', async () => {
    fake.failOnce.add('intent');
    const first = await makeGateway('worker-expiring').executeToolCall(decoyCall, decoyContext);
    expect(first.stage).toBe('FAILED');

    const intent = fake.intents.get(DECOY_KEY)!;
    intent['claimExpiresAt'] = new Date(Date.now() - 1000);

    const recovered = await makeGateway('worker-taking-over').executeToolCall(
      decoyCall,
      decoyContext,
    );

    expect(recovered.stage).toBe('FAKE_EXECUTED');
    expect(recovered.policyReason).toContain('Reconciled and recovered provider resource');
    expect(cloudRun.deployCount).toBe(1);
    expectAllProjectionsDurable(fake);
  });

  it('keeps the operation ambiguous rather than terminal when the outcome is unknown', async () => {
    // Provider intent is claimed and unexpired, and no provider effect is observable.
    await fake.reserveToolOperation({
      idempotencyKey: DECOY_KEY,
      eventId: EVENT_ID,
      toolName: 'request_decoy_deployment',
      authorized: true,
      policyReason: 'Prior attempt',
    });
    await fake.claimProviderIntent({
      idempotencyKey: DECOY_KEY,
      eventId: EVENT_ID,
      operationType: 'request_decoy_deployment',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-unknown-outcome',
    });

    const result = await makeGateway('worker-later').executeToolCall(decoyCall, decoyContext);

    expect(result.stage).toBe('FAILED');
    expect(result.details?.['error']).toBe('ACTIVE_CLAIM_HELD');
    expect(result.details?.['reconciliationRequired']).toBe(true);
    expect(fake.ledger.get(DECOY_KEY)?.['stage']).toBe('AUTHORIZED');
    expect(cloudRun.deployCount).toBe(0);
  });
});
