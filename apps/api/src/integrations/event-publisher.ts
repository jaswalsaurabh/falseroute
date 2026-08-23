import type { IntrusionEventEnvelope } from '@false-route/contracts';
import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export interface EventPublisher {
  publish(envelope: IntrusionEventEnvelope): Promise<{ transportId: string }>;
}

interface AuthenticatedRequestClient {
  request<T>(options: {
    readonly url: string;
    readonly method: 'POST';
    readonly data: unknown;
    readonly timeout: number;
  }): Promise<{ data: T }>;
}

export interface GooglePubSubEventPublisherOptions {
  readonly projectId: string;
  readonly topicId: string;
  readonly timeoutMs?: number;
  readonly client?: AuthenticatedRequestClient;
}

/** Publishes versioned event envelopes through the authenticated Pub/Sub REST API. */
export class GooglePubSubEventPublisher implements EventPublisher {
  private readonly timeoutMs: number;
  private clientPromise: Promise<AuthenticatedRequestClient> | undefined;

  constructor(private readonly options: GooglePubSubEventPublisherOptions) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) {
      throw new Error('Pub/Sub project ID is invalid');
    }
    if (!/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(options.topicId)) {
      throw new Error('Pub/Sub topic ID is invalid');
    }
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async publish(envelope: IntrusionEventEnvelope): Promise<{ transportId: string }> {
    const client = await this.getClient();
    const response = await client.request<{ messageIds?: string[] }>({
      url: `https://pubsub.googleapis.com/v1/projects/${this.options.projectId}/topics/${this.options.topicId}:publish`,
      method: 'POST',
      data: {
        messages: [{ data: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }],
      },
      timeout: this.timeoutMs,
    });
    const transportId = response.data.messageIds?.[0];
    if (!transportId) {
      throw new Error('Pub/Sub publish response did not contain a message ID');
    }
    return { transportId };
  }

  private getClient(): Promise<AuthenticatedRequestClient> {
    if (this.options.client) return Promise.resolve(this.options.client);
    this.clientPromise ??= new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/pubsub'],
    }).getClient() as Promise<AuthenticatedRequestClient>;
    return this.clientPromise;
  }
}

export interface LocalHttpEventPublisherOptions {
  readonly endpoint: string;
  readonly sharedSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Local transport adapter that exercises the worker's authenticated push boundary.
 * It deliberately uses the Pub/Sub push shape so local behavior does not bypass
 * validation, durable ingestion ownership, or autonomous orchestration.
 */
export class LocalHttpEventPublisher implements EventPublisher {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LocalHttpEventPublisherOptions) {
    if (
      !options.endpoint.startsWith('http://127.0.0.1:') &&
      !options.endpoint.startsWith('http://localhost:')
    ) {
      throw new Error('Local HTTP event publisher endpoint must target loopback');
    }
    if (options.sharedSecret.length < 16) {
      throw new Error('Local HTTP event publisher shared secret must be at least 16 characters');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async publish(envelope: IntrusionEventEnvelope): Promise<{ transportId: string }> {
    const transportId = `local-${randomUUID()}`;
    const response = await this.fetchImpl(this.options.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.sharedSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          data: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
          messageId: transportId,
          publishTime: new Date().toISOString(),
        },
        subscription: 'local/falseroute/autonomous-worker',
        deliveryAttempt: 1,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Local autonomous worker rejected event delivery with HTTP ${response.status}`,
      );
    }

    return { transportId };
  }
}

export class InMemoryEventPublisher implements EventPublisher {
  private readonly published: IntrusionEventEnvelope[] = [];
  private sequence = 0;

  async publish(envelope: IntrusionEventEnvelope): Promise<{ transportId: string }> {
    this.sequence += 1;
    const transportId = `mock-ps-msg-${Date.now()}-${this.sequence}`;
    this.published.push(envelope);
    return { transportId };
  }

  getPublishedEvents(): readonly IntrusionEventEnvelope[] {
    return this.published;
  }

  clear(): void {
    this.published.length = 0;
  }
}
