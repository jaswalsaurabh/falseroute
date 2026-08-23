import { describe, it, expect, vi } from 'vitest';
import { AutonomousWorkflowRepository } from './autonomous-workflow-repository.js';
import { ActivityEventRepository } from './activity-event-repository.js';
import type { PrismaClient } from '../generated/client/client.js';

describe('AutonomousWorkflowRepository', () => {
  it('detects duplicate ingestion receipts atomically', async () => {
    const mockPrisma = {
      ingestionReceipt: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;

    const repo = new AutonomousWorkflowRepository(mockPrisma);

    // Case 1: First receipt (not duplicate)
    vi.mocked(mockPrisma.ingestionReceipt.create).mockResolvedValueOnce({
      id: 'rec-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      transportId: 'ps-msg-01',
      source: 'PUB_SUB',
      status: 'ACCEPTED',
      receivedAt: new Date(),
      createdAt: new Date(),
    });

    const res1 = await repo.recordIngestionReceipt({
      eventId: '11111111-1111-4111-8111-111111111111',
      transportId: 'ps-msg-01',
      source: 'PUB_SUB',
    });

    expect(res1.isDuplicate).toBe(false);
    expect(res1.receipt.id).toBe('rec-1');

    // Case 2: Duplicate receipt (already exists)
    vi.mocked(mockPrisma.ingestionReceipt.create).mockRejectedValueOnce({ code: 'P2002' });
    vi.mocked(mockPrisma.ingestionReceipt.findUnique).mockResolvedValueOnce({
      id: 'rec-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      transportId: 'ps-msg-01',
      source: 'PUB_SUB',
      status: 'ACCEPTED',
      receivedAt: new Date(),
      createdAt: new Date(),
    });

    const res2 = await repo.recordIngestionReceipt({
      eventId: '11111111-1111-4111-8111-111111111111',
      transportId: 'ps-msg-01',
      source: 'PUB_SUB',
    });

    expect(res2.isDuplicate).toBe(true);
    expect(res2.receipt.id).toBe('rec-1');
  });

  it('reserves tool operation with cryptographic SHA-256 hashing', async () => {
    const createMock = vi
      .fn()
      .mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: 'tool-op-1',
        idempotencyKey: args.data['idempotencyKey'],
        eventId: args.data['eventId'],
        toolName: args.data['toolName'],
        inputHash: args.data['inputHash'],
        stage: args.data['stage'],
        authorized: args.data['authorized'],
        policyReason: args.data['policyReason'],
        providerResourceId: null,
        observedState: null,
        details: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    const mockPrisma = {
      toolOperationLedger: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: createMock,
      },
    } as unknown as PrismaClient;

    const repo = new AutonomousWorkflowRepository(mockPrisma);
    const res = await repo.reserveToolOperation({
      idempotencyKey: 'idem-key-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      toolName: 'request_decoy_deployment',
      input: { templateName: 'mock-admin-decoy' },
      authorized: true,
      policyReason: 'Authorized by policy',
    });

    expect(res.isExisting).toBe(false);
    expect(res.operation.id).toBe('tool-op-1');
    // inputHash must be a 64-char hex SHA-256 hash
    expect(res.operation.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('claims and completes provider intent records with a fencing token', async () => {
    const pendingIntent = {
      id: 'intent-1',
      idempotencyKey: 'idem-intent-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      operationType: 'DEPLOY_DECOY',
      provider: 'CLOUD_RUN',
      status: 'PENDING',
      payload: { template: 'mock-admin-decoy' },
      result: null,
      attemptCount: 0,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const claimedIntent = { ...pendingIntent, status: 'CLAIMED', version: 2 };
    const executedIntent = { ...claimedIntent, status: 'EXECUTED' };
    const mockPrisma = {
      providerIntentRecord: {
        create: vi.fn().mockResolvedValue(pendingIntent),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce(pendingIntent)
          .mockResolvedValueOnce(claimedIntent)
          .mockResolvedValueOnce(executedIntent),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const repo = new AutonomousWorkflowRepository(mockPrisma);

    const claim = await repo.claimProviderIntent({
      idempotencyKey: 'idem-intent-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      operationType: 'DEPLOY_DECOY',
      provider: 'CLOUD_RUN',
      claimOwner: 'worker-example-1',
      payload: { template: 'mock-admin-decoy' },
    });

    expect(claim.disposition).toBe('CLAIMED');
    expect(claim.claimToken).toBeDefined();

    const updated = await repo.updateProviderIntentStatus({
      idempotencyKey: 'idem-intent-1',
      claimToken: claim.claimToken!,
      status: 'EXECUTED',
      result: { serviceUrl: 'https://decoy.dummy' },
    });

    expect(updated.status).toBe('EXECUTED');
  });

  it('records and lists dead letter records durably', async () => {
    const mockPrisma = {
      deadLetterRecord: {
        create: vi.fn().mockResolvedValue({
          id: 'dlq-1',
          originalMessageId: 'ps-msg-999',
          originalEventId: null,
          failureReason: 'Schema-invalid JSON',
          retryCount: 0,
          payload: { raw: 'corrupt' },
          replayStatus: 'AVAILABLE',
          quarantinedAt: new Date(),
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'dlq-1',
            originalMessageId: 'ps-msg-999',
            originalEventId: null,
            failureReason: 'Schema-invalid JSON',
            retryCount: 0,
            payload: { raw: 'corrupt' },
            replayStatus: 'AVAILABLE',
            quarantinedAt: new Date(),
            createdAt: new Date(),
          },
        ]),
        update: vi.fn().mockResolvedValue({
          id: 'dlq-1',
          replayStatus: 'REPLAYED',
        }),
      },
    } as unknown as PrismaClient;

    const repo = new AutonomousWorkflowRepository(mockPrisma);

    const created = await repo.recordDeadLetter({
      originalMessageId: 'ps-msg-999',
      failureReason: 'Schema-invalid JSON',
      payload: { raw: 'corrupt' },
    });

    expect(created.id).toBe('dlq-1');
    expect(created.replayStatus).toBe('AVAILABLE');

    const list = await repo.listDeadLetters();
    expect(list.length).toBe(1);

    const replayed = await repo.markDeadLetterReplayed('dlq-1');
    expect(replayed.replayStatus).toBe('REPLAYED');
  });
});

describe('ActivityEventRepository', () => {
  it('records activity events with monotonic cursors', async () => {
    const mockPrisma = {
      activityEventRecord: {
        create: vi.fn().mockResolvedValue({
          cursor: 42,
          id: 'act-1',
          eventId: '11111111-1111-4111-8111-111111111111',
          correlationId: 'corr-1',
          stage: 'AUTHORIZED',
          eventType: 'DECISION_AUTHORIZED',
          summary: 'Policy authorized decoy deployment',
          provenance: 'DERIVED',
          payload: { action: 'DEPLOY_DECOY' },
          occurredAt: new Date(),
          createdAt: new Date(),
        }),
      },
    } as unknown as PrismaClient;

    const repo = new ActivityEventRepository(mockPrisma);
    const event = await repo.recordActivityEvent({
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-1',
      stage: 'AUTHORIZED',
      eventType: 'DECISION_AUTHORIZED',
      summary: 'Policy authorized decoy deployment',
      provenance: 'DERIVED',
      payload: { action: 'DEPLOY_DECOY' },
    });

    expect(event.cursor).toBe(42);
    expect(event.stage).toBe('AUTHORIZED');
  });
});
