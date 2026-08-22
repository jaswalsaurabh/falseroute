import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolGateway } from './tool-gateway.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';

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
});
