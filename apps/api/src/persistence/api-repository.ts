import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
  type SimulatedIntrusionEventInput,
  type ListIntrusionEventsQuery,
  IntrusionEventSchema,
  DeceptionDecisionSchema,
  SimulatedDeceptionEffectSchema,
} from '@false-route/contracts';
import {
  type DatabaseClient,
  type EventType,
  type ContainmentMode,
  type ProcessingStatus,
  type DeceptionAction,
  type ProvenanceClassification,
  Prisma,
} from '@false-route/database';

export interface ApiRepository {
  createEvent(
    input: SimulatedIntrusionEventInput,
    scenarioMeta?: { scenarioKind?: string; evidence?: unknown },
  ): Promise<IntrusionEvent>;
  listEvents(query: ListIntrusionEventsQuery): Promise<{ events: IntrusionEvent[]; total: number }>;
  getEventById(id: string): Promise<{
    event: IntrusionEvent;
    decision: DeceptionDecision | null;
    simulatedEffect: SimulatedDeceptionEffect | null;
  } | null>;
  getDecisionByEventId(eventId: string): Promise<{
    decision: DeceptionDecision;
    simulatedEffect: SimulatedDeceptionEffect | null;
  } | null>;
  checkHealth(): Promise<boolean>;
}

export class PrismaApiRepository implements ApiRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createEvent(
    input: SimulatedIntrusionEventInput,
    scenarioMeta?: { scenarioKind?: string; evidence?: unknown },
  ): Promise<IntrusionEvent> {
    const receivedAt = new Date();

    const created = await this.db.intrusionEvent.create({
      data: {
        id: input.id,
        occurredAt: new Date(input.occurredAt),
        receivedAt,
        correlationId: input.correlationId,
        sourceIp: input.sourceIp,
        targetAsset: input.targetAsset,
        eventType: input.eventType as EventType,
        failedLoginCount: input.failedLoginCount,
        riskIndicators: input.riskIndicators,
        containmentMode: input.containmentMode as ContainmentMode,
        usedDecoyCredential: input.usedDecoyCredential,
        decoyIdentifier:
          input.usedDecoyCredential && input.decoyIdentifier ? input.decoyIdentifier : null,
        scenarioKind: scenarioMeta?.scenarioKind ?? null,
        evidence: (scenarioMeta?.evidence as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        status: 'PENDING' as ProcessingStatus,
        provenance: 'OBSERVED' as ProvenanceClassification,
      },
    });

    const rawEvent = {
      id: created.id,
      occurredAt: created.occurredAt.toISOString(),
      receivedAt: created.receivedAt.toISOString(),
      correlationId: created.correlationId,
      sourceIp: created.sourceIp,
      targetAsset: created.targetAsset,
      eventType: created.eventType,
      failedLoginCount: created.failedLoginCount,
      riskIndicators: created.riskIndicators,
      containmentMode: created.containmentMode,
      usedDecoyCredential: created.usedDecoyCredential,
      decoyIdentifier: created.decoyIdentifier ?? undefined,
      status: 'PENDING' as const,
      provenance: 'OBSERVED' as const,
    };

    return IntrusionEventSchema.parse(rawEvent);
  }

  async listEvents(
    query: ListIntrusionEventsQuery,
  ): Promise<{ events: IntrusionEvent[]; total: number }> {
    const where = query.status ? { status: query.status as ProcessingStatus } : {};

    const [rows, total] = await Promise.all([
      this.db.intrusionEvent.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: { receivedAt: 'desc' },
      }),
      this.db.intrusionEvent.count({ where }),
    ]);

    const events = rows.map((row) =>
      IntrusionEventSchema.parse({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        receivedAt: row.receivedAt.toISOString(),
        correlationId: row.correlationId,
        sourceIp: row.sourceIp,
        targetAsset: row.targetAsset,
        eventType: row.eventType,
        failedLoginCount: row.failedLoginCount,
        riskIndicators: row.riskIndicators,
        containmentMode: row.containmentMode,
        usedDecoyCredential: row.usedDecoyCredential,
        decoyIdentifier: row.decoyIdentifier ?? undefined,
        status: row.status,
        provenance: row.provenance,
      }),
    );

    return { events, total };
  }

  async getEventById(id: string): Promise<{
    event: IntrusionEvent;
    decision: DeceptionDecision | null;
    simulatedEffect: SimulatedDeceptionEffect | null;
  } | null> {
    const row = await this.db.intrusionEvent.findUnique({
      where: { id },
      include: {
        decision: {
          include: {
            auditRecord: true,
            simulatedEffect: true,
          },
        },
      },
    });

    if (!row) return null;

    const event = IntrusionEventSchema.parse({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      correlationId: row.correlationId,
      sourceIp: row.sourceIp,
      targetAsset: row.targetAsset,
      eventType: row.eventType,
      failedLoginCount: row.failedLoginCount,
      riskIndicators: row.riskIndicators,
      containmentMode: row.containmentMode,
      usedDecoyCredential: row.usedDecoyCredential,
      decoyIdentifier: row.decoyIdentifier ?? undefined,
      status: row.status,
      provenance: row.provenance,
    });

    let decision: DeceptionDecision | null = null;
    let simulatedEffect: SimulatedDeceptionEffect | null = null;

    if (row.decision && row.decision.auditRecord) {
      decision = DeceptionDecisionSchema.parse({
        id: row.decision.id,
        eventId: row.decision.eventId,
        correlationId: row.decision.correlationId,
        action: row.decision.action as DeceptionAction,
        assignedFalseRoute: row.decision.assignedFalseRoute ?? undefined,
        matchedPolicy: row.decision.matchedPolicy,
        reason: row.decision.reason,
        containmentMode: row.decision.containmentMode,
        decisionProvenance: row.decision.decisionProvenance,
        decidedAt: row.decision.decidedAt.toISOString(),
        modelEnrichment: row.decision.modelEnrichment ?? undefined,
        auditRecord: {
          ruleVersion: row.decision.auditRecord.ruleVersion,
          evaluatedAt: row.decision.auditRecord.evaluatedAt.toISOString(),
        },
      });

      if (row.decision.simulatedEffect && row.decision.action === 'ASSIGN_FALSE_ROUTE') {
        simulatedEffect = SimulatedDeceptionEffectSchema.parse({
          id: row.decision.simulatedEffect.id,
          decisionId: row.decision.simulatedEffect.decisionId,
          correlationId: row.decision.simulatedEffect.correlationId,
          effectKind: row.decision.simulatedEffect.effectKind,
          status: row.decision.simulatedEffect.status,
          containmentMode: row.decision.simulatedEffect.containmentMode,
          assignedFalseRoute: row.decision.simulatedEffect.assignedFalseRoute,
          provenance: row.decision.simulatedEffect.provenance,
          recordedAt: row.decision.simulatedEffect.recordedAt.toISOString(),
          adapterVersion: row.decision.simulatedEffect.adapterVersion,
          createdAt: row.decision.simulatedEffect.createdAt.toISOString(),
        });
      }
    }

    return { event, decision, simulatedEffect };
  }

  async getDecisionByEventId(eventId: string): Promise<{
    decision: DeceptionDecision;
    simulatedEffect: SimulatedDeceptionEffect | null;
  } | null> {
    const row = await this.db.deceptionDecision.findUnique({
      where: { eventId },
      include: {
        auditRecord: true,
        simulatedEffect: true,
      },
    });

    if (!row || !row.auditRecord) return null;

    const decision = DeceptionDecisionSchema.parse({
      id: row.id,
      eventId: row.eventId,
      correlationId: row.correlationId,
      action: row.action as DeceptionAction,
      assignedFalseRoute: row.assignedFalseRoute ?? undefined,
      matchedPolicy: row.matchedPolicy,
      reason: row.reason,
      containmentMode: row.containmentMode,
      decisionProvenance: row.decisionProvenance,
      decidedAt: row.decidedAt.toISOString(),
      modelEnrichment: row.modelEnrichment ?? undefined,
      auditRecord: {
        ruleVersion: row.auditRecord.ruleVersion,
        evaluatedAt: row.auditRecord.evaluatedAt.toISOString(),
      },
    });

    let simulatedEffect: SimulatedDeceptionEffect | null = null;
    if (row.simulatedEffect && row.action === 'ASSIGN_FALSE_ROUTE') {
      simulatedEffect = SimulatedDeceptionEffectSchema.parse({
        id: row.simulatedEffect.id,
        decisionId: row.simulatedEffect.decisionId,
        correlationId: row.simulatedEffect.correlationId,
        effectKind: row.simulatedEffect.effectKind,
        status: row.simulatedEffect.status,
        containmentMode: row.simulatedEffect.containmentMode,
        assignedFalseRoute: row.simulatedEffect.assignedFalseRoute,
        provenance: row.simulatedEffect.provenance,
        recordedAt: row.simulatedEffect.recordedAt.toISOString(),
        adapterVersion: row.simulatedEffect.adapterVersion,
        createdAt: row.simulatedEffect.createdAt.toISOString(),
      });
    }

    return { decision, simulatedEffect };
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
