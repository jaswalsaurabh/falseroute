import { z } from 'zod';
import {
  type ToolName,
  RecommendResponsePlanParamsSchema,
  RequestDecoyDeploymentParamsSchema,
  RequestFalseRouteAssignmentParamsSchema,
  RequestSourceQuarantineParamsSchema,
  RequestOperatorAlertParamsSchema,
} from '@false-route/contracts';

export interface ToolDeclaration {
  readonly name: ToolName;
  readonly description: string;
  readonly parametersJsonSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties?: boolean;
    readonly [key: string]: unknown;
  };
}

export const TOOL_PARAM_SCHEMAS: Record<ToolName, z.ZodType> = {
  recommend_response_plan: RecommendResponsePlanParamsSchema,
  request_decoy_deployment: RequestDecoyDeploymentParamsSchema,
  request_false_route_assignment: RequestFalseRouteAssignmentParamsSchema,
  request_source_quarantine: RequestSourceQuarantineParamsSchema,
  request_operator_alert: RequestOperatorAlertParamsSchema,
};

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  recommend_response_plan:
    'Recommend an ordered response plan of autonomous actions based on intrusion evidence.',
  request_decoy_deployment:
    'Request dynamic deployment of an allowlisted Cloud Run decoy template.',
  request_false_route_assignment:
    'Request routing diversion of suspicious source traffic to a deployed decoy.',
  request_source_quarantine: 'Request source quarantine via dedicated Cloud Armor security policy.',
  request_operator_alert:
    'Request high-priority operator notification for critical security incidents.',
};

function normalizeSchemaNodes(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSchemaNodes);
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === '$schema') {
      continue;
    }
    if (key === 'const') {
      result['enum'] = [val];
      continue;
    }
    result[key] = normalizeSchemaNodes(val);
  }
  return result;
}

function toGeminiJsonSchema(schema: z.ZodType): ToolDeclaration['parametersJsonSchema'] {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  return normalizeSchemaNodes(jsonSchema) as ToolDeclaration['parametersJsonSchema'];
}

export function buildGeminiToolDeclarations(): readonly ToolDeclaration[] {
  const toolNames: readonly ToolName[] = [
    'recommend_response_plan',
    'request_decoy_deployment',
    'request_false_route_assignment',
    'request_source_quarantine',
    'request_operator_alert',
  ];

  return toolNames.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    parametersJsonSchema: toGeminiJsonSchema(TOOL_PARAM_SCHEMAS[name]),
  }));
}

export const GEMINI_TOOL_DECLARATIONS: readonly ToolDeclaration[] = buildGeminiToolDeclarations();
