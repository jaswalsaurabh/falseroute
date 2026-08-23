import {
  type CreateIntrusionEventRequest,
  type CreateIntrusionEventResponse,
  type ListIntrusionEventsQuery,
  type ListIntrusionEventsResponse,
  type GetIntrusionEventResponse,
  type GetDeceptionDecisionResponse,
  type IntrusionEventEnvelope,
  type CreateAutonomousScenarioRequest,
  IntrusionEventEnvelopeSchema,
  CreateIntrusionEventResponseSchema,
  ListIntrusionEventsResponseSchema,
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
} from '@false-route/contracts';
import { type ApiRepository } from '../persistence/api-repository.js';
import { type EventPublisher } from '../integrations/event-publisher.js';
import { NotFoundError } from '../middleware/error-handler.js';

export class EventService {
  constructor(
    private readonly repository: ApiRepository,
    private readonly eventPublisher?: EventPublisher,
  ) {}

  async createEvent(input: CreateIntrusionEventRequest): Promise<CreateIntrusionEventResponse> {
    const event = await this.repository.createEvent(input);

    return CreateIntrusionEventResponseSchema.parse({
      id: event.id,
      correlationId: event.correlationId,
      status: 'PENDING' as const,
      message: 'Intrusion event accepted for evaluation',
      receivedAt: event.receivedAt,
    });
  }

  async createAutonomousScenario(
    input: CreateAutonomousScenarioRequest,
  ): Promise<CreateIntrusionEventResponse> {
    if (!this.eventPublisher) {
      throw new Error('Autonomous event publisher is not configured');
    }

    const persistedInput: CreateIntrusionEventRequest = {
      id: input.id,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      sourceIp: input.sourceIp,
      targetAsset: 'mock-admin-portal',
      eventType:
        input.scenarioKind === 'SUSPICIOUS_IP_BURST'
          ? 'CREDENTIAL_STUFFING'
          : 'UNAUTHORIZED_ACCESS_ATTEMPT',
      failedLoginCount:
        input.evidence.scenarioKind === 'SUSPICIOUS_IP_BURST'
          ? input.evidence.burstCount
          : input.evidence.scenarioKind === 'DECOY_CREDENTIAL_USE'
            ? input.evidence.failedLoginCount
            : 1,
      riskIndicators: [input.scenarioKind],
      containmentMode: 'SIMULATED',
      ...(input.scenarioKind === 'DECOY_CREDENTIAL_USE'
        ? {
            usedDecoyCredential: true as const,
            decoyIdentifier: 'mock-admin-decoy-creds' as const,
          }
        : { usedDecoyCredential: false as const }),
    };
    let event: Awaited<ReturnType<ApiRepository['createEvent']>>;
    try {
      event = await this.repository.createEvent(persistedInput, {
        scenarioKind: input.scenarioKind,
        evidence: input.evidence,
      });
    } catch (createError) {
      // A client retry after an ambiguous publish must reuse the durable event
      // instead of creating a second event with the same simulator ID.
      let existing: Awaited<ReturnType<ApiRepository['getEventById']>>;
      try {
        existing = await this.repository.getEventById(input.id);
      } catch {
        throw createError;
      }
      if (!existing) throw createError;
      event = existing.event;
    }
    const envelope: IntrusionEventEnvelope = IntrusionEventEnvelopeSchema.parse({
      eventId: event.id,
      correlationId: event.correlationId,
      schemaVersion: '1.0.0',
      source: 'SIMULATOR',
      scenarioKind: input.scenarioKind,
      occurredAt: event.occurredAt,
      publishedAt: new Date().toISOString(),
      sourceIp: input.sourceIp,
      evidence: input.evidence,
      provenance: 'OBSERVED',
    });
    await this.eventPublisher.publish(envelope);

    return CreateIntrusionEventResponseSchema.parse({
      id: event.id,
      correlationId: event.correlationId,
      status: 'PENDING' as const,
      message: 'Autonomous scenario accepted and delivered for evaluation',
      receivedAt: event.receivedAt,
    });
  }

  async listEvents(query: ListIntrusionEventsQuery): Promise<ListIntrusionEventsResponse> {
    const { events, total } = await this.repository.listEvents(query);

    return ListIntrusionEventsResponseSchema.parse({
      events,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async getEvent(id: string): Promise<GetIntrusionEventResponse> {
    const result = await this.repository.getEventById(id);
    if (!result) {
      throw new NotFoundError(`Intrusion event not found: ${id}`);
    }

    return GetIntrusionEventResponseSchema.parse(result);
  }

  async getDecision(eventId: string): Promise<GetDeceptionDecisionResponse> {
    const result = await this.repository.getDecisionByEventId(eventId);
    if (!result) {
      throw new NotFoundError(`Deception decision not found for event: ${eventId}`);
    }

    return GetDeceptionDecisionResponseSchema.parse(result);
  }
}
