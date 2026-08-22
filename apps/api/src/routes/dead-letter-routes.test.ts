import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDeadLetterRouter } from './dead-letter-routes.js';
import { type DeadLetterService } from '../services/dead-letter-service.js';

const deadLetterId = '22222222-2222-4222-8222-222222222222';

function createService() {
  return {
    listRecords: vi.fn().mockResolvedValue([{ deadLetterId }]),
    replayRecord: vi.fn().mockResolvedValue({
      replayId: '33333333-3333-4333-8333-333333333333',
      originalEventId: '11111111-1111-4111-8111-111111111111',
      newTransportId: 'new-transport-1',
      replayedAt: '2026-08-22T10:06:00.000Z',
      status: 'ACCEPTED',
    }),
  };
}

function createRouterApp(service: ReturnType<typeof createService>, replayToken?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principalId = 'operator:verified-fingerprint';
    next();
  });
  app.use(
    createDeadLetterRouter({
      deadLetterService: service as unknown as DeadLetterService,
      ...(replayToken ? { replayToken } : {}),
    }),
  );
  return app;
}

describe('dead-letter routes', () => {
  it('awaits record listing before serializing the response', async () => {
    const service = createService();
    const response = await request(createRouterApp(service)).get('/');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ records: [{ deadLetterId }] });
  });

  it('fails closed when elevated replay authorization is not configured', async () => {
    const service = createService();
    const response = await request(createRouterApp(service))
      .post(`/${deadLetterId}/replay`)
      .send({ deadLetterId, rationale: 'Reviewed replay request' });
    expect(response.status).toBe(503);
    expect(service.replayRecord).not.toHaveBeenCalled();
  });

  it('requires a distinct elevated credential and passes verified identity to the service', async () => {
    const service = createService();
    const app = createRouterApp(service, 'not-a-real-elevated-replay-token');
    const denied = await request(app)
      .post(`/${deadLetterId}/replay`)
      .set('X-Replay-Authorization', 'Bearer not-a-real-wrong-replay-token')
      .send({ deadLetterId, rationale: 'Reviewed replay request' });
    expect(denied.status).toBe(403);

    const accepted = await request(app)
      .post(`/${deadLetterId}/replay`)
      .set('X-Replay-Authorization', 'Bearer not-a-real-elevated-replay-token')
      .send({ deadLetterId, rationale: 'Reviewed replay request' });
    expect(accepted.status).toBe(202);
    expect(service.replayRecord).toHaveBeenCalledWith(
      deadLetterId,
      expect.stringMatching(/^replay-operator:[0-9a-f]{16}$/),
      'Reviewed replay request',
    );
  });

  it('rejects invalid replay payload with 400', async () => {
    const service = createService();
    const app = createRouterApp(service, 'not-a-real-elevated-replay-token');
    const res = await request(app)
      .post(`/${deadLetterId}/replay`)
      .set('X-Replay-Authorization', 'Bearer not-a-real-elevated-replay-token')
      .send({ deadLetterId, rationale: 'sh' }); // Rationale too short
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects body and route deadLetterId mismatch with 400', async () => {
    const service = createService();
    const app = createRouterApp(service, 'not-a-real-elevated-replay-token');
    const res = await request(app)
      .post(`/${deadLetterId}/replay`)
      .set('X-Replay-Authorization', 'Bearer not-a-real-elevated-replay-token')
      .send({
        deadLetterId: '99999999-9999-4999-8999-999999999999',
        rationale: 'Reviewed replay request',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('must match the route identifier');
  });

  it('handles service errors with 400 REPLAY_FAILED', async () => {
    const service = createService();
    service.replayRecord.mockRejectedValueOnce(new Error('Record is not available for replay'));
    const app = createRouterApp(service, 'not-a-real-elevated-replay-token');
    const res = await request(app)
      .post(`/${deadLetterId}/replay`)
      .set('X-Replay-Authorization', 'Bearer not-a-real-elevated-replay-token')
      .send({ deadLetterId, rationale: 'Reviewed replay request' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('REPLAY_FAILED');
    expect(res.body.message).toContain('Record is not available');
  });
});
