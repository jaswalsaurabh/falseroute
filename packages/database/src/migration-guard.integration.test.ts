import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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

const TEST_DATABASE_URL = validateTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

describe('Database Migration & Safety Guard Integration', () => {
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

  it('fails closed when simulating the migration safety block on unreconciled legacy decisions', async () => {
    // Test the exact SQL logic embedded in migration 20260822084117_add_simulated_deception_effects
    const guardSql = `
      DO $$
      BEGIN
          IF EXISTS (
              SELECT 1 FROM "deception_decisions" d
              WHERE d."action" = 'ASSIGN_FALSE_ROUTE'
              AND NOT EXISTS (
                  SELECT 1 FROM "simulated_deception_effects" s
                  WHERE s."decision_id" = d."id"
              )
          ) THEN
              RAISE EXCEPTION 'Migration blocked: existing ASSIGN_FALSE_ROUTE decisions have no simulated effect evidence. Reconcile or explicitly archive those legacy decisions before retrying.'
              USING ERRCODE = 'check_violation';
          END IF;
      END $$;
    `;

    // On a clean/reconciled database with no orphaned ASSIGN_FALSE_ROUTE decisions, the guard passes
    await expect(db.$executeRawUnsafe(guardSql)).resolves.not.toThrow();

    // Verify the trigger also enforces this invariant for any new unsimulated ASSIGN_FALSE_ROUTE decision
    const eventId = randomUUID();
    const decisionId = randomUUID();
    createdFixtureIds.add(eventId);

    await db.intrusionEvent.create({
      data: {
        id: eventId,
        occurredAt: new Date(),
        receivedAt: new Date(),
        correlationId: `corr-guard-test-${Date.now()}`,
        sourceIp: '198.51.100.99',
        targetAsset: 'mock-admin-portal',
        eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
        failedLoginCount: 1,
        riskIndicators: [],
        containmentMode: ContainmentMode.SIMULATED,
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy-creds',
        status: ProcessingStatus.DECIDED,
        provenance: ProvenanceClassification.OBSERVED,
      },
    });

    // Attempting to create an ASSIGN_FALSE_ROUTE decision without an effect is blocked
    await expect(
      db.deceptionDecision.create({
        data: {
          id: decisionId,
          eventId,
          correlationId: `corr-guard-test-${Date.now()}`,
          action: DeceptionAction.ASSIGN_FALSE_ROUTE,
          assignedFalseRoute: 'mock-admin-decoy',
          matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
          reason: 'Testing migration guard integrity.',
          containmentMode: ContainmentMode.SIMULATED,
          decisionProvenance: ProvenanceClassification.DERIVED,
          decidedAt: new Date(),
        },
      }),
    ).rejects.toThrowError(/requires a corresponding simulated_deception_effects record/);
  });

  it('permits atomic creation of ASSIGN_FALSE_ROUTE decision and RECORDED simulated effect', async () => {
    const eventId = randomUUID();
    const decisionId = randomUUID();
    const effectId = randomUUID();
    const correlationId = `corr-valid-reconciled-${Date.now()}`;
    createdFixtureIds.add(eventId);

    const result = await db.$transaction(async (tx) => {
      const ev = await tx.intrusionEvent.create({
        data: {
          id: eventId,
          occurredAt: new Date(),
          receivedAt: new Date(),
          correlationId,
          sourceIp: '198.51.100.100',
          targetAsset: 'mock-admin-portal',
          eventType: EventType.UNAUTHORIZED_ACCESS_ATTEMPT,
          failedLoginCount: 1,
          riskIndicators: ['decoy_hit'],
          containmentMode: ContainmentMode.SIMULATED,
          usedDecoyCredential: true,
          decoyIdentifier: 'mock-admin-decoy-creds',
          status: ProcessingStatus.DECIDED,
          provenance: ProvenanceClassification.OBSERVED,
        },
      });

      const dec = await tx.deceptionDecision.create({
        data: {
          id: decisionId,
          eventId: ev.id,
          correlationId,
          action: DeceptionAction.ASSIGN_FALSE_ROUTE,
          assignedFalseRoute: 'mock-admin-decoy',
          matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
          reason: 'Decoy credential triggered simulated false-route containment.',
          containmentMode: ContainmentMode.SIMULATED,
          decisionProvenance: ProvenanceClassification.DERIVED,
          decidedAt: new Date(),
        },
      });

      const eff = await tx.simulatedDeceptionEffect.create({
        data: {
          id: effectId,
          decisionId: dec.id,
          correlationId,
          effectKind: DeceptionAction.ASSIGN_FALSE_ROUTE,
          status: 'RECORDED',
          containmentMode: ContainmentMode.SIMULATED,
          assignedFalseRoute: 'mock-admin-decoy',
          provenance: ProvenanceClassification.DERIVED,
          recordedAt: new Date(),
          adapterVersion: 'simulated-deception-agent-v1',
        },
      });

      return { event: ev, decision: dec, effect: eff };
    });

    expect(result.decision.action).toBe('ASSIGN_FALSE_ROUTE');
    expect(result.effect.status).toBe('RECORDED');
    expect(result.effect.containmentMode).toBe('SIMULATED');
    expect(result.effect.assignedFalseRoute).toBe('mock-admin-decoy');

    // Confirm that the guard SQL evaluates to true/pass on this reconciled state
    const guardSql = `
      DO $$
      BEGIN
          IF EXISTS (
              SELECT 1 FROM "deception_decisions" d
              WHERE d."id" = '${decisionId}'
              AND d."action" = 'ASSIGN_FALSE_ROUTE'
              AND NOT EXISTS (
                  SELECT 1 FROM "simulated_deception_effects" s
                  WHERE s."decision_id" = d."id"
              )
          ) THEN
              RAISE EXCEPTION 'Blocked';
          END IF;
      END $$;
    `;
    await expect(db.$executeRawUnsafe(guardSql)).resolves.not.toThrow();
  });
});
