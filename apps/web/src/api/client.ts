import {
  type CreateIntrusionEventRequest,
  type CreateIntrusionEventResponse,
  type CreateAutonomousScenarioRequest,
  type ListIntrusionEventsQuery,
  type ListIntrusionEventsResponse,
  type GetIntrusionEventResponse,
  type GetDeceptionDecisionResponse,
  type ReadinessCheckResponse,
  type HealthCheckResponse,
  CreateIntrusionEventResponseSchema,
  ListIntrusionEventsResponseSchema,
  GetIntrusionEventResponseSchema,
  GetDeceptionDecisionResponseSchema,
  ReadinessCheckResponseSchema,
  HealthCheckResponseSchema,
  ApiErrorResponseSchema,
} from '@false-route/contracts';

export class ApiError extends Error {
  readonly code: string;
  readonly correlationId?: string | undefined;
  readonly details?: string[] | undefined;

  constructor(message: string, code: string, correlationId?: string, details?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.correlationId = correlationId;
    this.details = details;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, baseUrl = '') {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    parser: (data: unknown) => T,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      ...(options.headers as Record<string, string>),
    };

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    const rawData = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const errorParsed = ApiErrorResponseSchema.safeParse(rawData);
      if (errorParsed.success) {
        throw new ApiError(
          errorParsed.data.message,
          errorParsed.data.error,
          errorParsed.data.correlationId,
          errorParsed.data.details,
        );
      }
      throw new ApiError(`HTTP Error ${response.status}: ${response.statusText}`, 'HTTP_ERROR');
    }

    return parser(rawData);
  }

  async checkReadiness(): Promise<ReadinessCheckResponse> {
    return this.request('/api/v1/ready', { method: 'GET' }, (data) =>
      ReadinessCheckResponseSchema.parse(data),
    );
  }

  async checkLiveness(): Promise<HealthCheckResponse> {
    return this.request('/api/v1/health', { method: 'GET' }, (data) =>
      HealthCheckResponseSchema.parse(data),
    );
  }

  async createEvent(event: CreateIntrusionEventRequest): Promise<CreateIntrusionEventResponse> {
    return this.request(
      '/api/v1/intrusion-events',
      {
        method: 'POST',
        body: JSON.stringify(event),
      },
      (data) => CreateIntrusionEventResponseSchema.parse(data),
    );
  }

  async createAutonomousScenario(
    scenario: CreateAutonomousScenarioRequest,
  ): Promise<CreateIntrusionEventResponse> {
    return this.request(
      '/api/v1/intrusion-events/scenarios',
      {
        method: 'POST',
        body: JSON.stringify(scenario),
      },
      (data) => CreateIntrusionEventResponseSchema.parse(data),
    );
  }

  async listEvents(query?: ListIntrusionEventsQuery): Promise<ListIntrusionEventsResponse> {
    const params = new URLSearchParams();
    if (query?.limit) params.set('limit', String(query.limit));
    if (query?.offset) params.set('offset', String(query.offset));
    if (query?.status) params.set('status', query.status);

    const queryString = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/v1/intrusion-events${queryString}`, { method: 'GET' }, (data) =>
      ListIntrusionEventsResponseSchema.parse(data),
    );
  }

  async getEvent(id: string): Promise<GetIntrusionEventResponse> {
    return this.request(`/api/v1/intrusion-events/${id}`, { method: 'GET' }, (data) =>
      GetIntrusionEventResponseSchema.parse(data),
    );
  }

  async getDecision(eventId: string): Promise<GetDeceptionDecisionResponse> {
    return this.request(`/api/v1/intrusion-events/${eventId}/decision`, { method: 'GET' }, (data) =>
      GetDeceptionDecisionResponseSchema.parse(data),
    );
  }
}
