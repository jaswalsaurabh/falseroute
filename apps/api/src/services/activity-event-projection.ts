import type { ActivityEvent } from '@false-route/contracts';
import type { ActivityEventRecordItem } from '@false-route/database';

export function deepRedactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((item) => deepRedactSensitiveData(item));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('credential') ||
      lower.includes('key') ||
      lower.includes('authorization') ||
      lower.includes('bearer') ||
      lower.includes('cookie')
    ) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = deepRedactSensitiveData(value);
    }
  }
  return result;
}

export function sanitizeActivityEvent(event: ActivityEvent): ActivityEvent {
  return {
    ...event,
    payload: event.payload
      ? (deepRedactSensitiveData(event.payload) as Record<string, unknown>)
      : undefined,
  };
}

export function toSafeActivityEvent(record: ActivityEventRecordItem): ActivityEvent {
  return sanitizeActivityEvent({
    cursor: record.cursor,
    eventId: record.eventId,
    correlationId: record.correlationId,
    stage: record.stage as ActivityEvent['stage'],
    eventType: record.eventType,
    summary: record.summary,
    provenance: record.provenance,
    occurredAt: record.occurredAt.toISOString(),
    payload: record.payload ?? undefined,
  });
}
