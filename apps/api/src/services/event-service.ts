import {
  type CreateIntrusionEventRequest,
  type CreateIntrusionEventResponse,
  type ListIntrusionEventsQuery,
  type ListIntrusionEventsResponse,
  type GetIntrusionEventResponse,
  type GetDeceptionDecisionResponse,
  CreateIntrusionEventResponseSchema,
  ListIntrusionEventsResponseSchema,
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
} from '@false-route/contracts';
import { type ApiRepository } from '../persistence/api-repository.js';
import { NotFoundError } from '../middleware/error-handler.js';

export class EventService {
  constructor(private readonly repository: ApiRepository) {}

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
