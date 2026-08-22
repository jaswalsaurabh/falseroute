import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createDatabaseClient,
  validateTestDatabaseUrl,
  type DatabaseClient,
  ProcessingStatus,
  ContainmentMode,
  EventType,
  DeceptionAction,
  ProvenanceClassification,
} from './index.js';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

describe('PostgreSQL Database Persistence Integration', () => {
  let db: DatabaseClient;
  const createdFixtureIds = new Set<string>();

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: TEST_DATABASE_URL });
    await db.$connect();
  });

  afterAll(async () => {
    if (db) {
      if (createdFixtureIds.size > 0) {
        await db.intrusionEvent.deleteMany({
          where: { id: { in: Array.from(createdFixtureIds) } },
        });
      }
      await db.$disconnect();
    }
  });

  it('inserts and retrieves a canonical event, decision, and audit record with relations', async () => {
    const eventId = randomUUID();
    const decisionId = randomUUID();
    const auditId = randomUUID();
    const correlationId = `corr-test-${Date.now()}`;

    // 1. Insert IntrusionEvent
    const event = await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date('2026-08-21T18:00:00.000Z'),
        receivedAt: new Date('2026-08-21T18:00:01.000Z'),
        correlationId,
        sourceIp: '192.0.2.45',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 3,
        riskIndicators: ['rapid_retry', 'decoy_credential_hit'],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: ProcessingStatus.DECIDED,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });

    expect(event.id).toBe(eventId);
    expect(event.sourceIp).toBe('192.0.2.45');
    expect(event.usedDecoyCredential).toBe(true);

    // 2. Insert DeceptionDecision
    const decision = await db.deceptionDecision.create({
      data: {
        id: decisionId,
        eventId: event.id,
        correlationId,
        action: DeceptionAction.ASSIGN_FALSE_ROUTE,
        assignedFalseRoute: 'mock-admin-decoy',
        matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
        reason: 'Decoy administrative credentials observed in simulated intake.',
        containmentMode: ContainmentMode.SIMULATED,
        decisionProvenance: ProvenanceClassification.DERIVED,
        decidedAt: new Date('2026-08-21T18:00:02.000Z'),
        modelEnrichment: {
          confidence: 0.95,
          summary: 'High confidence decoy credential usage pattern.',
        },
      },
    });

    expect(decision.id).toBe(decisionId);
    expect(decision.action).toBe(DeceptionAction.ASSIGN_FALSE_ROUTE);
    expect(decision.assignedFalseRoute).toBe('mock-admin-decoy');

    // 3. Insert DecisionAuditRecord
    const auditRecord = await db.decisionAuditRecord.create({
      data: {
        id: auditId,
        decisionId: decision.id,
        ruleVersion: '2026-08.1',
        evaluatedAt: new Date('2026-08-21T18:00:02.500Z'),
      },
    });

    expect(auditRecord.id).toBe(auditId);
    expect(auditRecord.decisionId).toBe(decisionId);

    // 4. Query full relational tree
    const fetchedEvent = await db.intrusionEvent.findUnique({
      where: { id: eventId },
      include: {
        decision: {
          include: {
            auditRecord: true,
          },
        },
      },
    });

    expect(fetchedEvent).not.toBeNull();
    expect(fetchedEvent?.id).toBe(eventId);
    expect(fetchedEvent?.decision?.id).toBe(decisionId);
    expect(fetchedEvent?.decision?.auditRecord?.id).toBe(auditId);
    expect(fetchedEvent?.decision?.auditRecord?.ruleVersion).toBe('2026-08.1');

    // 5. Verify Cascade Deletion
    await db.intrusionEvent.delete({ where: { id: eventId } });

    const deletedDecision = await db.deceptionDecision.findUnique({
      where: { id: decisionId },
    });
    const deletedAudit = await db.decisionAuditRecord.findUnique({
      where: { id: auditId },
    });

    expect(deletedDecision).toBeNull();
    expect(deletedAudit).toBeNull();
  });

  it('enforces database check constraint rejecting contradictory decoy states', async () => {
    const invalidEventId = randomUUID();

    // usedDecoyCredential is true, but decoyIdentifier is null
    await expect(
      db.intrusionEvent.create({
        data: {
          id: invalidEventId,
          occurredAt: new Date(),
          receivedAt: new Date(),
          correlationId: `corr-invalid-${Date.now()}`,
          sourceIp: '198.51.100.12',
          targetAsset: 'mock-admin-portal',
          eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
          failedLoginCount: 1,
          riskIndicators: [],
          containmentMode: ContainmentMode.SIMULATED,
          usedDecoyCredential: true,
          decoyIdentifier: null, // Violates chk_intrusion_events_decoy
          status: ProcessingStatus.PENDING,
          provenance: ProvenanceClassification.OBSERVED,
        },
      }),
    ).rejects.toThrowError(/chk_intrusion_events_decoy/);
  });

  it('enforces database check constraint rejecting contradictory false-route action states', async () => {
    const eventId = randomUUID();
    const decisionId = randomUUID();

    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId: `corr-test-route-${Date.now()}`,
        sourceIp: '198.51.100.13',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 0,
        riskIndicators: [],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: false,
        decoyIdentifier: null,
        status: ProcessingStatus.PENDING,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });

    // Action is ALLOW, but assignedFalseRoute is non-null
    await expect(
      db.deceptionDecision.create({
        data: {
          id: decisionId,
          eventId,
          correlationId: `corr-test-route-${Date.now()}`,
          action: DeceptionAction.ALLOW,
          assignedFalseRoute: 'mock-admin-decoy', // Violates chk_deception_decisions_action_route
          matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
          reason: 'Invalid state test.',
          containmentMode: ContainmentMode.SIMULATED,
          decisionProvenance: ProvenanceClassification.DERIVED,
          decidedAt: new Date(),
        },
      }),
    ).rejects.toThrowError(/chk_deception_decisions_action_route/);

    // Clean up parent event
    await db.intrusionEvent.delete({ where: { id: eventId } });
  });

  it('enforces database check constraint rejecting negative failed login counts', async () => {
    const invalidEventId = randomUUID();

    await expect(
      db.intrusionEvent.create({
        data: {
          id: invalidEventId,
          occurredAt: new Date(),
          receivedAt: new Date(),
          correlationId: `corr-invalid-count-${Date.now()}`,
          sourceIp: '198.51.100.14',
          targetAsset: 'mock-admin-portal',
          eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
          failedLoginCount: -5, // Violates chk_intrusion_events_failed_login_count
          riskIndicators: [],
          containmentMode: ContainmentMode.SIMULATED,
          usedDecoyCredential: false,
          decoyIdentifier: null,
          status: ProcessingStatus.PENDING,
          provenance: ProvenanceClassification.OBSERVED,
        },
      }),
    ).rejects.toThrowError(/chk_intrusion_events_failed_login_count/);
  });
});
