import type { IntrusionEventEnvelope } from '@false-route/contracts';
import { randomUUID } from 'node:crypto';

export interface EventPublisher {
  publish(envelope: IntrusionEventEnvelope): Promise<{ transportId: string }>;
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
