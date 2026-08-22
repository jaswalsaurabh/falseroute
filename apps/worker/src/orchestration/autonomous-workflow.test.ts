import { describe, it, expect, vi } from 'vitest';
import { AutonomousWorkflowOrchestrator } from './autonomous-workflow.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { type IntrusionEventEnvelope } from '@false-route/contracts';

describe('AutonomousWorkflowOrchestrator', () => {
  it('processes valid ENV_FILE_PROBE event and records complete lifecycle', async () => {
    const mockWorkflowRepo = {
      recordIngestionReceipt: vi.fn().mockResolvedValue({ isDuplicate: false }),
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
      recordDeliveryAttempt: vi.fn().mockResolvedValue({}),
    } as unknown as AutonomousWorkflowRepository;

    const mockActivityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;

    const orchestrator = new AutonomousWorkflowOrchestrator(mockWorkflowRepo, mockActivityRepo);

    const envelope: IntrusionEventEnvelope = {
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

    const result = await orchestrator.processEventEnvelope(envelope, 'msg-ps-1234');
    expect(result.status).toBe('COMPLETED');
    expect(result.executedActions).toContain('request_decoy_deployment');
    expect(result.executedActions).toContain('request_false_route_assignment');
    expect(result.acknowledged).toBe(true);
  });

  it('skips side effects on duplicate message delivery', async () => {
    const mockWorkflowRepo = {
      recordIngestionReceipt: vi.fn().mockResolvedValue({ isDuplicate: true }),
    } as unknown as AutonomousWorkflowRepository;

    const mockActivityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;

    const orchestrator = new AutonomousWorkflowOrchestrator(mockWorkflowRepo, mockActivityRepo);

    const envelope: IntrusionEventEnvelope = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-orch-2',
      schemaVersion: '1.0.0',
      source: 'PUB_SUB',
      scenarioKind: 'DECOY_CREDENTIAL_USE',
      occurredAt: '2026-08-22T10:00:00.000Z',
      publishedAt: '2026-08-22T10:00:01.000Z',
      sourceIp: '198.51.100.31',
      evidence: {
        scenarioKind: 'DECOY_CREDENTIAL_USE',
        sourceIp: '198.51.100.31',
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy',
        targetAsset: 'mock-admin-portal',
        failedLoginCount: 1,
        isPositiveMatch: true,
      },
      provenance: 'OBSERVED',
    };

    const result = await orchestrator.processEventEnvelope(envelope, 'msg-duplicate-1234');
    expect(result.status).toBe('DUPLICATE');
    expect(result.executedActions).toEqual([]);
    expect(result.acknowledged).toBe(true);
  });
});
