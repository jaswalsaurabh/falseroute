import { describe, expect, it, vi } from 'vitest';
import type { IntrusionEventEnvelope } from '@false-route/contracts';
import { GooglePubSubEventPublisher, LocalHttpEventPublisher } from './event-publisher.js';

const envelope: IntrusionEventEnvelope = {
  eventId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'corr-local-publisher-1',
  schemaVersion: '1.0.0',
  source: 'SIMULATOR',
  scenarioKind: 'ENV_FILE_PROBE',
  occurredAt: '2026-08-22T10:00:00.000Z',
  publishedAt: '2026-08-22T10:00:01.000Z',
  sourceIp: '198.51.100.25',
  evidence: {
    scenarioKind: 'ENV_FILE_PROBE',
    requestedPath: '/.env',
    httpMethod: 'GET',
    userAgent: 'not-a-real-local-scanner/1.0',
    sourceIp: '198.51.100.25',
    matchedString: '.env',
    isPositiveMatch: true,
  },
  provenance: 'OBSERVED',
};

describe('LocalHttpEventPublisher', () => {
  it('delivers an authenticated Pub/Sub-shaped request to the worker', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const publisher = new LocalHttpEventPublisher({
      endpoint: 'http://127.0.0.1:8080/pubsub/push',
      sharedSecret: 'not-a-real-local-push-token',
      fetchImpl,
    });

    const result = await publisher.publish(envelope);
    expect(result.transportId).toMatch(/^local-/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer not-a-real-local-push-token',
    );
    const body = JSON.parse(String(init.body)) as {
      message: { messageId: string; data: string };
    };
    expect(body.message.messageId).toBe(result.transportId);
    expect(JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'))).toEqual(envelope);
  });

  it('refuses non-loopback endpoints', () => {
    expect(
      () =>
        new LocalHttpEventPublisher({
          endpoint: 'https://example.com/pubsub/push',
          sharedSecret: 'not-a-real-local-push-token',
        }),
    ).toThrow('must target loopback');
  });

  it('fails when the autonomous worker rejects delivery', async () => {
    const publisher = new LocalHttpEventPublisher({
      endpoint: 'http://localhost:8080/pubsub/push',
      sharedSecret: 'not-a-real-local-push-token',
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
    });

    await expect(publisher.publish(envelope)).rejects.toThrow('HTTP 503');
  });
});

describe('GooglePubSubEventPublisher', () => {
  it('publishes the encoded envelope and returns the provider message ID', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ data: { messageIds: ['message-123'] } }),
    };
    const publisher = new GooglePubSubEventPublisher({
      projectId: 'falseroute-staging-123',
      topicId: 'falseroute-events',
      client,
    });

    await expect(publisher.publish(envelope)).resolves.toEqual({ transportId: 'message-123' });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://pubsub.googleapis.com/v1/projects/falseroute-staging-123/topics/falseroute-events:publish',
        method: 'POST',
        timeout: 5000,
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
      projectId: 'falseroute-staging-123',
      topicId: 'falseroute-events',
      client: { request: vi.fn().mockResolvedValue({ data: {} }) },
    });

    await expect(publisher.publish(envelope)).rejects.toThrow('did not contain a message ID');
  });
});
