import { z } from 'zod';
import { IpAddressSchema, IsoDateTimeSchema, UuidSchema } from './primitives.js';
import { ResponseActionSchema } from './workflow.js';
import { IncidentAssessmentSchema } from './incident-intelligence.js';

export const ToolNameSchema = z.enum([
  'recommend_response_plan',
  'request_decoy_deployment',
  'request_false_route_assignment',
  'request_source_quarantine',
  'request_operator_alert',
]);

export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolExecutionStageSchema = z.enum([
  'REQUESTED',
  'REJECTED',
  'AUTHORIZED',
  'NARROWED',
  'FAKE_EXECUTED',
  'EXECUTED',
  'FAILED',
  'ROLLED_BACK',
]);

export type ToolExecutionStage = z.infer<typeof ToolExecutionStageSchema>;

// Tool parameters schemas
export const RecommendResponsePlanParamsSchema = z
  .object({
    eventId: UuidSchema,
    recommendedActions: z.array(ResponseActionSchema).min(1).max(5),
    rationale: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type RecommendResponsePlanParams = z.infer<typeof RecommendResponsePlanParamsSchema>;

export const RequestDecoyDeploymentParamsSchema = z
  .object({
    eventId: UuidSchema,
    templateName: z.enum(['mock-admin-decoy', 'mock-wordpress-decoy']),
    region: z.literal('us-central1'),
    ttlSeconds: z.number().int().min(60).max(3600),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type RequestDecoyDeploymentParams = z.infer<typeof RequestDecoyDeploymentParamsSchema>;

export const RequestFalseRouteAssignmentParamsSchema = z
  .object({
    eventId: UuidSchema,
    sourceIp: IpAddressSchema,
    targetDecoyService: z.string().min(1).max(128),
    ttlSeconds: z.number().int().min(60).max(3600),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type RequestFalseRouteAssignmentParams = z.infer<
  typeof RequestFalseRouteAssignmentParamsSchema
>;

export const RequestSourceQuarantineParamsSchema = z
  .object({
    eventId: UuidSchema,
    sourceIp: IpAddressSchema,
    cidrPrefix: z.union([z.literal(32), z.literal(128)]),
    ttlSeconds: z.number().int().min(60).max(3600),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type RequestSourceQuarantineParams = z.infer<typeof RequestSourceQuarantineParamsSchema>;

export const RequestOperatorAlertParamsSchema = z
  .object({
    eventId: UuidSchema,
    severity: z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']),
    headline: z.string().min(1).max(256),
    details: z.string().min(1).max(1000),
  })
  .strict();

export type RequestOperatorAlertParams = z.infer<typeof RequestOperatorAlertParamsSchema>;

export const ToolCallSchema = z
  .object({
    toolCallId: z.string().min(1).max(64),
    toolName: ToolNameSchema,
    parameters: z.record(z.string(), z.unknown()),
    requestedAt: IsoDateTimeSchema,
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const AutonomousToolCallSchema = z
  .object({
    toolCallId: z.string().min(1).max(64),
    toolName: ToolNameSchema,
    parameters: z.record(z.string(), z.unknown()),
    requestedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((call, context) => {
    switch (call.toolName) {
      case 'recommend_response_plan': {
        const result = RecommendResponsePlanParamsSchema.safeParse(call.parameters);
        if (!result.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters'],
            message: `Invalid parameters for recommend_response_plan: ${result.error.message}`,
          });
        }
        break;
      }
      case 'request_decoy_deployment': {
        const result = RequestDecoyDeploymentParamsSchema.safeParse(call.parameters);
        if (!result.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters'],
            message: `Invalid parameters for request_decoy_deployment: ${result.error.message}`,
          });
        }
        break;
      }
      case 'request_false_route_assignment': {
        const result = RequestFalseRouteAssignmentParamsSchema.safeParse(call.parameters);
        if (!result.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters'],
            message: `Invalid parameters for request_false_route_assignment: ${result.error.message}`,
          });
        }
        break;
      }
      case 'request_source_quarantine': {
        const result = RequestSourceQuarantineParamsSchema.safeParse(call.parameters);
        if (!result.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters'],
            message: `Invalid parameters for request_source_quarantine: ${result.error.message}`,
          });
        }
        break;
      }
      case 'request_operator_alert': {
        const result = RequestOperatorAlertParamsSchema.safeParse(call.parameters);
        if (!result.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters'],
            message: `Invalid parameters for request_operator_alert: ${result.error.message}`,
          });
        }
        break;
      }
      default: {
        const exhaustiveCheck: never = call.toolName;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolName'],
          message: `Unknown tool name: ${exhaustiveCheck}`,
        });
      }
    }
  });

export type AutonomousToolCall = z.infer<typeof AutonomousToolCallSchema>;

export const AutonomousModelAnalysisResultSchema = z
  .object({
    status: z.literal('SUCCESS'),
    correlationId: z.string().min(1).max(64),
    modelIdentifier: z.string().min(1).max(128),
    evaluatedAt: IsoDateTimeSchema,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(500),
    toolRequests: z.array(AutonomousToolCallSchema).max(5),
    assessment: IncidentAssessmentSchema.optional(),
    provenance: z.literal('INFERRED'),
  })
  .strict();

export type AutonomousModelAnalysisResult = z.infer<typeof AutonomousModelAnalysisResultSchema>;

export const AutonomousDegradedModelResultSchema = z
  .object({
    status: z.enum(['DEGRADED', 'TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT']),
    correlationId: z.string().min(1).max(64),
    modelIdentifier: z.string().min(1).max(128).optional(),
    evaluatedAt: IsoDateTimeSchema,
    reason: z.string().min(1).max(500),
    provenance: z.literal('UNAVAILABLE'),
  })
  .strict();

export type AutonomousDegradedModelResult = z.infer<typeof AutonomousDegradedModelResultSchema>;

export const AutonomousModelAnalysisSchema = z.union([
  AutonomousModelAnalysisResultSchema,
  AutonomousDegradedModelResultSchema,
]);

export type AutonomousModelAnalysis = z.infer<typeof AutonomousModelAnalysisSchema>;

export const ToolResultSchema = z
  .object({
    toolCallId: z.string().min(1).max(64),
    toolName: ToolNameSchema,
    stage: ToolExecutionStageSchema,
    idempotencyKey: z.string().min(1).max(128),
    authorized: z.boolean(),
    policyReason: z.string().min(1).max(500),
    providerResourceId: z.string().max(256).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    executedAt: IsoDateTimeSchema,
  })
  .strict();

export type ToolResult = z.infer<typeof ToolResultSchema>;
