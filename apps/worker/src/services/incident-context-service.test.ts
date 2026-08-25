import { describe, expect, it } from 'vitest';
import { IncidentContextService, type RelatedIncidentSignal } from './incident-context-service.js';

const currentEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  correlationId: 'corr-not-a-real-context-1',
  schemaVersion: '1.0.0' as const,
  source: 'SIMULATOR' as const,
  scenarioKind: 'SQL_INJECTION_PROBE' as const,
  occurredAt: '2026-08-24T10:00:00.000Z',
  publishedAt: '2026-08-24T10:00:01.000Z',
  sourceIp: '192.0.2.10',
  evidence: {
    scenarioKind: 'SQL_INJECTION_PROBE',
    sourceIp: '192.0.2.10',
    queryParameter: 'id',
    matchedString: "' OR 1=1",
    isPositiveMatch: true,
  },
  provenance: 'OBSERVED' as const,
};

function relatedSignal(
  signalId: string,
  observedAt: string,
  overrides: Partial<RelatedIncidentSignal> = {},
): RelatedIncidentSignal {
  return {
    signalId,
    correlationId: currentEvent.correlationId,
    syntheticSource: 'fixed-replay',
    scenarioKind: 'PATH_TRAVERSAL_PROBE',
    summary: 'Bounded synthetic path traversal signal',
    observedAt,
    evidence: [
      {
        evidenceId: `${signalId}:observation`,
        evidenceType: 'PATH_TRAVERSAL_PROBE',
        observedAt,
        provenance: 'OBSERVED',
      },
    ],
    ...overrides,
  };
}

describe('IncidentContextService', () => {
  it('keeps only same-correlation/source signals, sorts newest first, deduplicates, and caps at five', async () => {
    const records = [
      relatedSignal('event-5', '2026-08-24T10:05:00.000Z'),
      relatedSignal('event-5', '2026-08-24T10:05:00.000Z'),
      relatedSignal('event-2', '2026-08-24T10:02:00.000Z'),
      relatedSignal('event-3', '2026-08-24T10:03:00.000Z'),
      relatedSignal('event-4', '2026-08-24T10:04:00.000Z'),
      relatedSignal('event-6', '2026-08-24T10:06:00.000Z'),
      relatedSignal('unrelated', '2026-08-24T10:07:00.000Z', {
        correlationId: 'other-correlation',
      }),
      relatedSignal('other-source', '2026-08-24T10:08:00.000Z', {
        syntheticSource: 'other-source',
      }),
    ];
    const service = new IncidentContextService({
      findRelatedSignals: async () => records,
    });

    const result = await service.build({
      currentEvent,
      syntheticSource: 'fixed-replay',
      currentSummary: 'Current bounded SQL injection signal',
    });

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.context.signals.map((signal) => signal.signalId)).toEqual([
        currentEvent.eventId,
        'event-6',
        'event-5',
        'event-4',
        'event-3',
      ]);
      expect(result.context.signals).toHaveLength(5);
      expect(result.context.evidence).toHaveLength(5);
    }
  });

  it('marks missing history PARTIAL while retaining observed provenance', async () => {
    const service = new IncidentContextService({ findRelatedSignals: async () => [] });
    const result = await service.build({
      currentEvent,
      syntheticSource: 'fixed-replay',
      currentSummary: 'Current bounded SQL injection signal',
    });

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.context.contextCompleteness).toBe('INSUFFICIENT');
      expect(result.context.evidence[0]?.provenance).toBe('OBSERVED');
    }
  });

  it('marks bounded related history COMPLETE when it fits without truncation', async () => {
    const service = new IncidentContextService({
      findRelatedSignals: async () => [relatedSignal('prior-event', '2026-08-24T09:59:00.000Z')],
    });
    const result = await service.build({
      currentEvent,
      syntheticSource: 'fixed-replay',
      currentSummary: 'Current bounded SQL injection signal',
    });

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') expect(result.context.contextCompleteness).toBe('COMPLETE');
  });

  it('returns an explicit degraded result when the repository fails', async () => {
    const service = new IncidentContextService({
      findRelatedSignals: async () => {
        throw new Error('database unavailable');
      },
    });

    await expect(
      service.build({
        currentEvent,
        syntheticSource: 'fixed-replay',
        currentSummary: 'Current bounded SQL injection signal',
      }),
    ).resolves.toEqual({
      status: 'DEGRADED',
      reason: 'REPOSITORY_ERROR',
      message: 'Unable to read related incident signals: database unavailable',
    });
  });

  it('rejects malformed related evidence instead of inventing a valid context', async () => {
    const service = new IncidentContextService({
      findRelatedSignals: async () => [
        relatedSignal('bad-record', '2026-08-24T10:01:00.000Z', {
          evidence: [
            {
              evidenceId: 'bad record with spaces',
              evidenceType: 'PATH_TRAVERSAL_PROBE',
              observedAt: '2026-08-24T10:01:00.000Z',
              provenance: 'OBSERVED',
            },
          ],
        }),
      ],
    });

    const result = await service.build({
      currentEvent,
      syntheticSource: 'fixed-replay',
      currentSummary: 'Current bounded SQL injection signal',
    });
    expect(result).toMatchObject({ status: 'DEGRADED', reason: 'INVALID_RECORD' });
  });
});
