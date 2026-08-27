import { describe, expect, it, vi } from 'vitest';
import type { IntrusionEventEnvelope } from '@false-route/contracts';
import { GooglePubSubEventPublisher } from './pubsub-event-publisher.js';

const envelope: IntrusionEventEnvelope = {
  eventId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'corr-campaign-publisher',
  schemaVersion: '1.0.0',
  source: 'WORKER',
  scenarioKind: 'PATH_TRAVERSAL_PROBE',
  occurredAt: '2026-08-24T00:00:02.000Z',
  publishedAt: '2026-08-24T00:00:03.000Z',
  sourceIp: '192.0.2.10',
  evidence: {
    scenarioKind: 'PATH_TRAVERSAL_PROBE',
    requestedPath: '/../../etc/passwd',
    httpMethod: 'GET',
    userAgent: 'FalseRoute-campaign/1.0.0',
    sourceIp: '192.0.2.10',
    isPositiveMatch: true,
  },
  provenance: 'OBSERVED',
};

describe('GooglePubSubEventPublisher', () => {
  it('publishes a campaign continuation and returns the provider message ID', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ data: { messageIds: ['message-2'] } }),
    };
    const publisher = new GooglePubSubEventPublisher({
      projectId: 'example-project',
      topicId: 'falseroute-events',
      client,
      timeoutMs: 4000,
    });

    await expect(publisher.publish(envelope)).resolves.toEqual({ transportId: 'message-2' });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://pubsub.googleapis.com/v1/projects/example-project/topics/falseroute-events:publish',
        method: 'POST',
        timeout: 4000,
      }),
    );
    const request = client.request.mock.calls[0]![0] as {
      data: { messages: { data: string }[] };
    };
    expect(
      JSON.parse(Buffer.from(request.data.messages[0]!.data, 'base64').toString('utf8')),
    ).toEqual(envelope);
  });

  it('fails closed when Pub/Sub omits the message ID', async () => {
    const publisher = new GooglePubSubEventPublisher({
      projectId: 'example-project',
      topicId: 'falseroute-events',
      client: { request: vi.fn().mockResolvedValue({ data: {} }) },
    });

    await expect(publisher.publish(envelope)).rejects.toThrow('did not contain a message ID');
  });
});
