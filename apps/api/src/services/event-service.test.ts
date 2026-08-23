import { describe, expect, it, vi } from 'vitest';
import type { ApiRepository } from '../persistence/api-repository.js';
import { EventService } from './event-service.js';

const event = {
  id: '11111111-1111-4111-8111-111111111111',
  occurredAt: '2026-08-22T10:00:00.000Z',
  receivedAt: '2026-08-22T10:00:01.000Z',
  correlationId: 'corr-retry-1',
  sourceIp: '198.51.100.25',
  targetAsset: 'mock-admin-portal',
  eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT' as const,
  failedLoginCount: 1,
  riskIndicators: ['ENV_FILE_PROBE'],
  containmentMode: 'SIMULATED' as const,
  usedDecoyCredential: false,
  status: 'PENDING' as const,
  provenance: 'OBSERVED' as const,
};

const input = {
  id: event.id,
  occurredAt: event.occurredAt,
  correlationId: event.correlationId,
  scenarioKind: 'ENV_FILE_PROBE' as const,
  sourceIp: event.sourceIp,
  evidence: {
    scenarioKind: 'ENV_FILE_PROBE' as const,
    requestedPath: '/.env',
    httpMethod: 'GET' as const,
    userAgent: 'not-a-real-scanner/1.0',
    sourceIp: event.sourceIp,
    matchedString: '.env',
    isPositiveMatch: true,
  },
};

describe('EventService autonomous publication recovery', () => {
  it('reuses an existing event when a client retries after persistence ambiguity', async () => {
    const repository = {
      createEvent: vi.fn().mockRejectedValue(new Error('unique constraint')),
      getEventById: vi.fn().mockResolvedValue({ event, decision: null, simulatedEffect: null }),
    } as unknown as ApiRepository;
    const publisher = { publish: vi.fn().mockResolvedValue({ transportId: 'message-1' }) };

    const response = await new EventService(repository, publisher).createAutonomousScenario(input);

    expect(response.id).toBe(event.id);
    expect(repository.getEventById).toHaveBeenCalledWith(event.id);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});
