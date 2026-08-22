import { describe, it, expect } from 'vitest';
import {
  EventSourceSchema,
  WorkflowStatusSchema,
  ResponseActionSchema,
  LeaseStatusSchema,
  SystemModeSchema,
  IntrusionEventEnvelopeSchema,
  DeliveryAttemptRecordSchema,
  ReplayAttemptRecordSchema,
} from './workflow.js';

describe('Workflow Contracts & Envelopes', () => {
  it('validates all canonical enums', () => {
    expect(EventSourceSchema.safeParse('PUB_SUB').success).toBe(true);
    expect(EventSourceSchema.safeParse('SIMULATOR').success).toBe(true);
    expect(EventSourceSchema.safeParse('INVALID_SOURCE').success).toBe(false);

    expect(WorkflowStatusSchema.safeParse('RECEIVED').success).toBe(true);
    expect(WorkflowStatusSchema.safeParse('AUTHORIZED').success).toBe(true);
    expect(WorkflowStatusSchema.safeParse('COMPLETED').success).toBe(true);

    expect(ResponseActionSchema.safeParse('DEPLOY_DECOY').success).toBe(true);
    expect(ResponseActionSchema.safeParse('ASSIGN_FALSE_ROUTE').success).toBe(true);
    expect(ResponseActionSchema.safeParse('QUARANTINE_SOURCE').success).toBe(true);

    expect(LeaseStatusSchema.safeParse('ACTIVE').success).toBe(true);
    expect(LeaseStatusSchema.safeParse('CLEANED_UP').success).toBe(true);

    expect(SystemModeSchema.safeParse('LOCAL_FAKE').success).toBe(true);
    expect(SystemModeSchema.safeParse('SIMULATED').success).toBe(true);
    expect(SystemModeSchema.safeParse('LIVE').success).toBe(true);
  });

  it('validates a complete IntrusionEventEnvelope', () => {
    const validEnvelope = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dummy-test-1234',
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

    const parsed = IntrusionEventEnvelopeSchema.safeParse(validEnvelope);
    expect(parsed.success).toBe(true);
  });

  it('rejects envelope with invalid schemaVersion or unexpected fields', () => {
    const invalidVersion = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dummy-test-1234',
      schemaVersion: '2.0.0',
      source: 'PUB_SUB',
      scenarioKind: 'ENV_FILE_PROBE',
      occurredAt: '2026-08-22T10:00:00.000Z',
      publishedAt: '2026-08-22T10:00:01.000Z',
      sourceIp: '198.51.100.25',
      evidence: {},
      provenance: 'OBSERVED',
    };
    expect(IntrusionEventEnvelopeSchema.safeParse(invalidVersion).success).toBe(false);
  });

  it('rejects envelope and evidence source IP disagreement', () => {
    const mismatched = {
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-dummy-test-1234',
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
        sourceIp: '198.51.100.99',
        matchedString: '.env',
        isPositiveMatch: true,
      },
      provenance: 'OBSERVED',
    };
    expect(IntrusionEventEnvelopeSchema.safeParse(mismatched).success).toBe(false);
  });

  it('validates DeliveryAttemptRecord and ReplayAttemptRecord', () => {
    const delivery = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      eventId: '11111111-1111-4111-8111-111111111111',
      transportId: 'ps-msg-dummy-123',
      workerId: 'worker-instance-01',
      attemptNumber: 1,
      status: 'SUCCESS',
      attemptedAt: '2026-08-22T10:00:02.000Z',
    };
    expect(DeliveryAttemptRecordSchema.safeParse(delivery).success).toBe(true);

    const replay = {
      replayId: '33333333-3333-4333-8333-333333333333',
      originalEventId: '11111111-1111-4111-8111-111111111111',
      originalTransportId: 'ps-msg-dummy-123',
      newTransportId: 'ps-msg-dummy-456',
      requestedBy: 'operator-dummy-alice',
      rationale: 'Replaying after transient network fault resolved',
      replayedAt: '2026-08-22T10:05:00.000Z',
    };
    expect(ReplayAttemptRecordSchema.safeParse(replay).success).toBe(true);
  });
});
