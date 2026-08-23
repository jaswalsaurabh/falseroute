import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '@false-route/contracts';
import { ActivityStreamConsumer } from './ActivityStreamConsumer.js';

describe('ActivityStreamConsumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('consumes the authenticated initial snapshot before opening the resumable stream', async () => {
    const event: ActivityEvent = {
      cursor: 7,
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-snapshot-1',
      stage: 'RECEIVED',
      eventType: 'INTRUSION_INGESTED',
      summary: 'Persisted activity restored from snapshot',
      provenance: 'OBSERVED',
      occurredAt: '2026-08-22T10:00:00.000Z',
    };
    const seen: ActivityEvent[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes('/api/v1/activity?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [event],
              latestCursor: 7,
              systemMode: 'LOCAL_FAKE',
              totalCount: 1,
            }),
        });
      }
      expect(options?.headers).toMatchObject({ 'Last-Event-ID': '7' });
      return Promise.resolve({
        ok: true,
        body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const consumer = new ActivityStreamConsumer('not-a-real-operator-token', '', {
      onEvent: (received) => seen.push(received),
    });
    consumer.start();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(seen).toEqual([event]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/activity?limit=100');
    consumer.stop();
  });
});
