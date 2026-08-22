import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolGateway } from './tool-gateway.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { FakeCloudRunAdapter } from './fake-cloud-adapters.js';

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

  it('emits TOOL_FAILED activity event when encountering existing failed ledger reservation', async () => {
    vi.mocked(mockWorkflowRepo.reserveToolOperation).mockResolvedValueOnce({
      isExisting: true,
      operation: {
        id: 'op-failed',
        idempotencyKey: 'idem-failed',
        eventId: '11111111-1111-4111-8111-111111111111',
        toolName: 'request_decoy_deployment',
        inputHash: 'hash-failed-1',
        stage: 'FAILED',
        authorized: true,
        policyReason: 'Prior failure',
      },
    });

    const result = await gateway.executeToolCall(
      {
        toolCallId: 'call-failed-replay',
        toolName: 'request_decoy_deployment',
        parameters: {
          eventId: '11111111-1111-4111-8111-111111111111',
          templateName: 'mock-admin-decoy',
          region: 'us-central1',
          ttlSeconds: 300,
          reason: 'Replaying failed op',
        },
        requestedAt: new Date().toISOString(),
      },
      {
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-replay-fail',
        scenarioKind: 'ENV_FILE_PROBE',
        sourceIp: '198.51.100.25',
        isPositiveMatch: true,
        isNegativeControl: false,
      },
    );

    expect(result.stage).toBe('FAILED');
    expect(mockActivityRepo.recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TOOL_FAILED',
        stage: 'FAILED',
        payload: {
          toolName: 'request_decoy_deployment',
          error: 'Provider outcome requires explicit reconciliation before retry',
        },
      }),
    );
  });
});
