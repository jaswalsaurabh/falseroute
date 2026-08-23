import { describe, it, expect } from 'vitest';
import {
  ActivityEventSchema,
  ActivitySnapshotResponseSchema,
  SseEventTypeSchema,
} from './activity-event.js';

describe('Activity Event & SSE Contracts', () => {
  it('validates ActivityEvent schema with monotonic cursor and bounded payload', () => {
    const event = {
      cursor: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dummy-test-1234',
      stage: 'AUTHORIZED',
      eventType: 'DECISION_FINALIZED',
      summary: 'Deterministic policy authorized decoy deployment and false-route assignment',
      provenance: 'DERIVED',
      occurredAt: '2026-08-22T10:00:03.000Z',
      payload: {
        action: 'DEPLOY_DECOY',
        targetTemplate: 'mock-admin-decoy',
      },
    };

    expect(ActivityEventSchema.safeParse(event).success).toBe(true);
  });

  it('validates ActivitySnapshotResponseSchema', () => {
    const snapshot = {
      events: [
        {
          cursor: 1,
          eventId: '11111111-1111-4111-8111-111111111111',
          correlationId: 'corr-dummy-test-1234',
          stage: 'RECEIVED',
          eventType: 'INTRUSION_RECEIVED',
          summary: 'Ingested intrusion event from Pub/Sub topic',
          provenance: 'OBSERVED',
          occurredAt: '2026-08-22T10:00:01.000Z',
        },
      ],
      latestCursor: 1,
      systemMode: 'LOCAL_FAKE',
      totalCount: 1,
    };

    expect(ActivitySnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
  });

  it('validates SSE event types', () => {
    expect(SseEventTypeSchema.safeParse('activity').success).toBe(true);
    expect(SseEventTypeSchema.safeParse('heartbeat').success).toBe(true);
    expect(SseEventTypeSchema.safeParse('system_mode').success).toBe(true);
    expect(SseEventTypeSchema.safeParse('unknown').success).toBe(false);
  });
});
