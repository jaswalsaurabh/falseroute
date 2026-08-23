import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GoogleOidcTokenVerifier,
  LocalSharedSecretOidcTokenVerifier,
  PubSubPushHandler,
} from './pubsub-push-handler.js';
import { type AutonomousWorkflowOrchestrator } from '../orchestration/autonomous-workflow.js';
import { type AutonomousWorkflowRepository } from '@false-route/database';

describe('PubSubPushHandler', () => {
  const localSecret = 'not-a-real-local-push-secret';
  const verifier = new LocalSharedSecretOidcTokenVerifier(localSecret);
  const mockOrchestrator = {
    processEventEnvelope: vi.fn().mockResolvedValue({
      status: 'COMPLETED',
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-1',
      executedActions: ['request_decoy_deployment'],
      acknowledged: true,
    }),
  } as unknown as AutonomousWorkflowOrchestrator;

  const mockRepo = {
    recordDeadLetter: vi.fn().mockResolvedValue({ id: 'dlq-1' }),
  } as unknown as AutonomousWorkflowRepository;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated push request with 401', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const res = await handler.handlePushRequest(undefined, {});
    expect(res.statusCode).toBe(401);
  });

  it('acknowledges schema-invalid poison envelope with 200 and durably quarantines', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const res = await handler.handlePushRequest(`Bearer ${localSecret}`, { invalidEnvelope: true });
    expect(res.statusCode).toBe(200);
    expect(res.body['status']).toBe('QUARANTINED');
    expect(mockRepo.recordDeadLetter).toHaveBeenCalled();
  });

  it('acknowledges unparseable base64 message data with 200 and durably quarantines', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const rawBody = {
      message: {
        data: Buffer.from('invalid-non-json-string').toString('base64'),
        messageId: 'msg-poison-1',
        publishTime: '2026-08-22T10:00:00.000Z',
      },
      subscription: 'projects/dummy/subscriptions/worker-sub',
    };

    const res = await handler.handlePushRequest(`Bearer ${localSecret}`, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body['status']).toBe('QUARANTINED');
    expect(mockRepo.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        originalMessageId: 'msg-poison-1',
      }),
    );
  });

  it('processes valid envelope and returns 200 OK', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const validEnvelope = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-valid-1',
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

    const rawBody = {
      message: {
        data: Buffer.from(JSON.stringify(validEnvelope)).toString('base64'),
        messageId: 'msg-valid-1',
        publishTime: '2026-08-22T10:00:01.000Z',
      },
      subscription: 'projects/dummy/subscriptions/worker-sub',
    };

    const res = await handler.handlePushRequest(`Bearer ${localSecret}`, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body['status']).toBe('COMPLETED');
  });

  it('rejects a plausible but incorrect local bearer token', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const res = await handler.handlePushRequest('Bearer not-a-real-wrong-push-secret', {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a cryptographically valid token with the wrong audience or service identity', async () => {
    const productionVerifier = {
      verifyToken: vi.fn().mockResolvedValue({
        valid: true,
        email: 'wrong-invoker@example-project.iam.gserviceaccount.com',
        audience: 'https://wrong.example.com/pubsub/push',
      }),
    };
    const handler = new PubSubPushHandler(mockOrchestrator, productionVerifier, mockRepo, {
      expectedServiceAccount: 'pubsub-invoker@example-project.iam.gserviceaccount.com',
      expectedAudience: 'https://worker.example.com/pubsub/push',
    });
    const res = await handler.handlePushRequest('Bearer not-a-real-signed-oidc-token', {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects expired OIDC tokens with 401', async () => {
    const expiredVerifier = {
      verifyToken: vi.fn().mockResolvedValue({ valid: false }),
    };
    const handler = new PubSubPushHandler(mockOrchestrator, expiredVerifier, mockRepo);
    const res = await handler.handlePushRequest('Bearer not-a-real-expired-token', {});
    expect(res.statusCode).toBe(401);
  });

  it('does not expose provider error details on transient processing failures', async () => {
    const failingOrchestrator = {
      processEventEnvelope: vi.fn().mockRejectedValue(new Error('postgres password leaked')),
    } as unknown as AutonomousWorkflowOrchestrator;
    const handler = new PubSubPushHandler(failingOrchestrator, verifier, mockRepo);
    const response = await handler.handlePushRequest(`Bearer ${localSecret}`, {
      message: {
        data: Buffer.from(
          JSON.stringify({
            eventId: '11111111-1111-4111-8111-111111111111',
            correlationId: 'corr-transient-1',
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
          }),
        ).toString('base64'),
        messageId: 'msg-transient-1',
        publishTime: '2026-08-22T10:00:01.000Z',
      },
      subscription: 'projects/dummy/subscriptions/worker-sub',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: 'TRANSIENT_FAILURE',
      message: 'Event processing failed; delivery will be retried',
    });
  });

  it('handles duplicate poison delivery idempotently', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const rawBody = {
      message: {
        data: Buffer.from('unparseable-data').toString('base64'),
        messageId: 'msg-poison-duplicate-1',
        publishTime: '2026-08-22T10:00:00.000Z',
      },
      subscription: 'projects/dummy/subscriptions/worker-sub',
    };

    const res1 = await handler.handlePushRequest(`Bearer ${localSecret}`, rawBody);
    expect(res1.statusCode).toBe(200);
    expect(res1.body['status']).toBe('QUARANTINED');

    const res2 = await handler.handlePushRequest(`Bearer ${localSecret}`, rawBody);
    expect(res2.statusCode).toBe(200);
    expect(res2.body['status']).toBe('QUARANTINED');
    expect(mockRepo.recordDeadLetter).toHaveBeenCalledTimes(2);
  });

  it('requests redelivery when poison quarantine persistence fails', async () => {
    const unavailableRepo = {
      recordDeadLetter: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as AutonomousWorkflowRepository;
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, unavailableRepo);
    const res = await handler.handlePushRequest(`Bearer ${localSecret}`, {
      invalidEnvelope: true,
    });

    expect(res.statusCode).toBe(503);
    expect(res.body['error']).toBe('QUARANTINE_UNAVAILABLE');
  });

  it('durably records broker dead letters for operator replay', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const event = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dlq-1',
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
    const request = {
      message: {
        data: Buffer.from(JSON.stringify(event)).toString('base64'),
        messageId: 'broker-dlq-message-1',
        publishTime: '2026-08-22T10:05:00.000Z',
        attributes: { CloudPubSubDeadLetterSourceDeliveryCount: '5' },
      },
      subscription: 'projects/dummy/subscriptions/events-dlq-sub',
    };

    const response = await handler.handleDeadLetterRequest(`Bearer ${localSecret}`, request);

    expect(response.statusCode).toBe(200);
    expect(mockRepo.recordDeadLetter).toHaveBeenCalledWith({
      originalMessageId: 'broker-dlq-message-1',
      originalEventId: event.eventId,
      failureReason: 'Pub/Sub delivery attempts exhausted',
      payload: event,
      retryCount: 5,
    });
    expect(mockOrchestrator.processEventEnvelope).not.toHaveBeenCalled();
  });

  it('requests broker dead-letter redelivery when durable storage is unavailable', async () => {
    const unavailableRepo = {
      recordDeadLetter: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as AutonomousWorkflowRepository;
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, unavailableRepo);
    const event = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dlq-2',
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

    const response = await handler.handleDeadLetterRequest(`Bearer ${localSecret}`, {
      message: {
        data: Buffer.from(JSON.stringify(event)).toString('base64'),
        messageId: 'broker-dlq-message-2',
        publishTime: '2026-08-22T10:05:00.000Z',
      },
      subscription: 'projects/dummy/subscriptions/events-dlq-sub',
    });

    expect(response.statusCode).toBe(503);
    expect(response.body['error']).toBe('QUARANTINE_UNAVAILABLE');
  });

  it('durably records invalid broker dead letters for inspection', async () => {
    const handler = new PubSubPushHandler(mockOrchestrator, verifier, mockRepo);
    const response = await handler.handleDeadLetterRequest(`Bearer ${localSecret}`, {
      message: {
        data: Buffer.from('not-json').toString('base64'),
        messageId: 'broker-dlq-poison-1',
        publishTime: '2026-08-22T10:05:00.000Z',
        attributes: { CloudPubSubDeadLetterSourceDeliveryCount: '5' },
      },
      subscription: 'projects/dummy/subscriptions/events-dlq-sub',
    });

    expect(response.statusCode).toBe(200);
    expect(mockRepo.recordDeadLetter).toHaveBeenCalledWith({
      originalMessageId: 'broker-dlq-poison-1',
      failureReason: 'Pub/Sub delivery attempts exhausted; payload is not valid JSON',
      payload: { rawData: Buffer.from('not-json').toString('base64') },
      retryCount: 5,
    });
  });
});

describe('GoogleOidcTokenVerifier', () => {
  it('returns verified audience and service-account claims', async () => {
    const client = {
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({
          aud: 'https://staging.example.com/worker',
          email: 'push@example-project.iam.gserviceaccount.com',
        }),
      }),
    };
    const verifier = new GoogleOidcTokenVerifier(client);

    await expect(
      verifier.verifyToken('Bearer not-a-real-signed-token', {
        expectedAudience: 'https://staging.example.com/worker',
      }),
    ).resolves.toEqual({
      valid: true,
      audience: 'https://staging.example.com/worker',
      email: 'push@example-project.iam.gserviceaccount.com',
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'not-a-real-signed-token',
      audience: 'https://staging.example.com/worker',
    });
  });

  it('fails closed for missing or unverifiable tokens', async () => {
    const client = { verifyIdToken: vi.fn().mockRejectedValue(new Error('invalid token')) };
    const verifier = new GoogleOidcTokenVerifier(client);

    await expect(verifier.verifyToken(undefined, {})).resolves.toEqual({ valid: false });
    await expect(verifier.verifyToken('Bearer not-a-real-invalid-token', {})).resolves.toEqual({
      valid: false,
    });
  });
});
