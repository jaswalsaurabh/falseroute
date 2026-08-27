import { GoogleAuth } from 'google-auth-library';
import type { IntrusionEventEnvelope } from '@false-route/contracts';

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

/** Publishes campaign continuation events through the authenticated Pub/Sub REST API. */
export class GooglePubSubEventPublisher {
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

  async publish(envelope: IntrusionEventEnvelope): Promise<{ readonly transportId: string }> {
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
