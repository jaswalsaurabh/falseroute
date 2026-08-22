export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

export const GEMINI_TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: 'recommend_response_plan',
    description:
      'Recommend an ordered response plan of autonomous actions based on intrusion evidence.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the intrusion event' },
        recommendedActions: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'RECOMMEND_PLAN',
              'DEPLOY_DECOY',
              'ASSIGN_FALSE_ROUTE',
              'QUARANTINE_SOURCE',
              'ALERT_OPERATOR',
              'REJECT_ACCESS',
              'NO_ACTION',
            ],
          },
          description: 'Ordered list of recommended response actions',
        },
        rationale: { type: 'string', description: 'Justification for the recommended actions' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence score' },
      },
      required: ['eventId', 'recommendedActions', 'rationale', 'confidence'],
    },
  },
  {
    name: 'request_decoy_deployment',
    description: 'Request dynamic deployment of an allowlisted Cloud Run decoy template.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the intrusion event' },
        templateName: {
          type: 'string',
          enum: ['mock-admin-decoy', 'mock-wordpress-decoy'],
          description: 'Allowlisted decoy template name',
        },
        region: { type: 'string', enum: ['us-central1'], description: 'Target region' },
        ttlSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 3600,
          description: 'Lease time-to-live in seconds',
        },
        reason: { type: 'string', description: 'Operational reason for decoy deployment' },
      },
      required: ['eventId', 'templateName', 'region', 'ttlSeconds', 'reason'],
    },
  },
  {
    name: 'request_false_route_assignment',
    description: 'Request routing diversion of suspicious source traffic to a deployed decoy.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the intrusion event' },
        sourceIp: { type: 'string', description: 'Source IP address to divert' },
        targetDecoyService: { type: 'string', description: 'Target decoy service identifier' },
        ttlSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 3600,
          description: 'Route assignment TTL in seconds',
        },
        reason: { type: 'string', description: 'Operational reason for route diversion' },
      },
      required: ['eventId', 'sourceIp', 'targetDecoyService', 'ttlSeconds', 'reason'],
    },
  },
  {
    name: 'request_source_quarantine',
    description: 'Request source quarantine via dedicated Cloud Armor security policy.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the intrusion event' },
        sourceIp: { type: 'string', description: 'Source IP to quarantine' },
        cidrPrefix: {
          type: 'integer',
          enum: [32, 128],
          description: 'Strict /32 (IPv4) or /128 (IPv6) mask',
        },
        ttlSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 3600,
          description: 'Quarantine lease TTL in seconds',
        },
        reason: { type: 'string', description: 'Operational reason for quarantine' },
      },
      required: ['eventId', 'sourceIp', 'cidrPrefix', 'ttlSeconds', 'reason'],
    },
  },
  {
    name: 'request_operator_alert',
    description: 'Request high-priority operator notification for critical security incidents.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the intrusion event' },
        severity: {
          type: 'string',
          enum: ['INFO', 'WARNING', 'HIGH', 'CRITICAL'],
          description: 'Alert severity',
        },
        headline: { type: 'string', description: 'Brief alert headline' },
        details: { type: 'string', description: 'Detailed alert message' },
      },
      required: ['eventId', 'severity', 'headline', 'details'],
    },
  },
];
