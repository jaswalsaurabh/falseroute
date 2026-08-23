import { describe, expect, it, vi } from 'vitest';
import { type AutonomousWorkflowRepository } from '@false-route/database';
import { type EventPublisher } from '../integrations/event-publisher.js';
import { DeadLetterService } from './dead-letter-service.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const deadLetterId = '22222222-2222-4222-8222-222222222222';
const replayAttemptId = '33333333-3333-4333-8333-333333333333';
const payload = {
  eventId,
  correlationId: 'corr-dlq-replay-1',
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
    userAgent: 'not-a-real-replay-scanner/1.0',
    sourceIp: '198.51.100.25',
    matchedString: '.env',
    isPositiveMatch: true,
  },
  provenance: 'OBSERVED',
};

function createRepo() {
  const record = {
    id: deadLetterId,
    originalMessageId: 'original-message-1',
    originalEventId: eventId,
    failureReason: 'Retry exhausted',
    retryCount: 3,
    payload,
    replayStatus: 'AVAILABLE',
    quarantinedAt: new Date('2026-08-22T10:05:00.000Z'),
    createdAt: new Date('2026-08-22T10:05:00.000Z'),
  };
  return {
    getDeadLetterById: vi.fn().mockResolvedValue(record),
    claimDeadLetterForReplay: vi.fn().mockResolvedValue({
      claimed: true,
      record: { ...record, replayStatus: 'REPLAYING' },
      replayAttempt: { id: replayAttemptId },
    }),
    completeReplayClaim: vi.fn().mockResolvedValue({
      id: replayAttemptId,
      completedAt: new Date('2026-08-22T10:06:00.000Z'),
    }),
    failReplayClaim: vi.fn().mockResolvedValue({}),
  };
}

describe('DeadLetterService', () => {
  it('claims before publish and persists the actual transport identity', async () => {
    const repo = createRepo();
    const publisher = {
      publish: vi.fn().mockResolvedValue({ transportId: 'new-transport-1' }),
    };
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    const result = await service.replayRecord(
      deadLetterId,
      'operator:verified',
      'Retry reviewed event',
    );

    expect(repo.claimDeadLetterForReplay.mock.invocationCallOrder[0]).toBeLessThan(
      publisher.publish.mock.invocationCallOrder[0]!,
    );
    expect(repo.completeReplayClaim).toHaveBeenCalledWith({
      replayAttemptId,
      newTransportId: 'new-transport-1',
    });
    expect(result).toEqual({
      replayId: replayAttemptId,
      originalEventId: eventId,
      newTransportId: 'new-transport-1',
      replayedAt: '2026-08-22T10:06:00.000Z',
      status: 'ACCEPTED',
    });
  });

  it('marks a claimed replay for review when transport publication fails', async () => {
    const repo = createRepo();
    const publisher = {
      publish: vi.fn().mockRejectedValue(new Error('transport unavailable')),
    };
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    await expect(
      service.replayRecord(deadLetterId, 'operator:verified', 'Retry reviewed event'),
    ).rejects.toThrow('transport unavailable');
    expect(repo.failReplayClaim).toHaveBeenCalledWith({
      replayAttemptId,
      reason: expect.stringContaining('transport unavailable'),
    });
  });

  it('rejects a payload whose event identity differs from the durable record', async () => {
    const repo = createRepo();
    repo.getDeadLetterById.mockResolvedValueOnce({
      ...(await repo.getDeadLetterById()),
      originalEventId: '44444444-4444-4444-8444-444444444444',
    });
    const publisher = { publish: vi.fn() } as unknown as EventPublisher;
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    await expect(
      service.replayRecord(deadLetterId, 'operator:verified', 'Retry reviewed event'),
    ).rejects.toThrow('identity does not match');
    expect(repo.claimDeadLetterForReplay).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('rejects replay when record is already replayed or not available', async () => {
    const repo = createRepo();
    repo.getDeadLetterById.mockResolvedValueOnce({
      ...(await repo.getDeadLetterById()),
      replayStatus: 'REPLAYED',
    });
    const publisher = { publish: vi.fn() } as unknown as EventPublisher;
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    await expect(
      service.replayRecord(deadLetterId, 'operator:verified', 'Retry reviewed event'),
    ).rejects.toThrow('not available for replay');
  });

  it('rejects replay when concurrent claim races and loses', async () => {
    const repo = createRepo();
    repo.claimDeadLetterForReplay.mockResolvedValueOnce({
      claimed: false,
      record: await repo.getDeadLetterById(),
      replayAttempt: null,
    });
    const publisher = { publish: vi.fn() } as unknown as EventPublisher;
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    await expect(
      service.replayRecord(deadLetterId, 'operator:verified', 'Retry reviewed event'),
    ).rejects.toThrow('already claimed or terminal');
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('requires operator reconciliation when DB completion fails after publish', async () => {
    const repo = createRepo();
    repo.completeReplayClaim.mockRejectedValueOnce(new Error('DB disconnect after publish'));
    const publisher = {
      publish: vi.fn().mockResolvedValue({ transportId: 'new-transport-1' }),
    };
    const service = new DeadLetterService(
      repo as unknown as AutonomousWorkflowRepository,
      publisher,
    );

    await expect(
      service.replayRecord(deadLetterId, 'operator:verified', 'Retry reviewed event'),
    ).rejects.toThrow(
      'Replay was published but durable completion requires operator reconciliation',
    );
    expect(repo.failReplayClaim).toHaveBeenCalled();
  });
});
