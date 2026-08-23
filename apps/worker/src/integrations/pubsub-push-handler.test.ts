import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalSharedSecretOidcTokenVerifier, PubSubPushHandler } from './pubsub-push-handler.js';
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
});
