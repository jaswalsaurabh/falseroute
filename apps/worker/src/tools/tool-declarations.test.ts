import { describe, it, expect } from 'vitest';
import {
  GEMINI_TOOL_DECLARATIONS,
  TOOL_PARAM_SCHEMAS,
  TOOL_DESCRIPTIONS,
} from './tool-declarations.js';
import { ToolNameSchema, type ToolName } from '@false-route/contracts';

function checkNoConst(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(checkNoConst);
    return;
  }
  const obj = node as Record<string, unknown>;
  expect(obj['const']).toBeUndefined();
  for (const val of Object.values(obj)) {
    checkNoConst(val);
  }
}

describe('GEMINI_TOOL_DECLARATIONS Mechanical Synchronization', () => {
  const expectedToolNames: readonly ToolName[] = [
    'recommend_response_plan',
    'request_decoy_deployment',
    'request_false_route_assignment',
    'request_source_quarantine',
    'request_operator_alert',
  ];

  it('declares exactly the five closed tool catalog entries with non-empty descriptions', () => {
    expect(GEMINI_TOOL_DECLARATIONS.length).toBe(5);
    const declaredNames = GEMINI_TOOL_DECLARATIONS.map((t) => t.name);
    expect(declaredNames.toSorted()).toEqual(expectedToolNames.toSorted());

    for (const tool of GEMINI_TOOL_DECLARATIONS) {
      expect(ToolNameSchema.safeParse(tool.name).success).toBe(true);
      expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parametersJsonSchema.type).toBe('object');
      expect(tool.parametersJsonSchema.additionalProperties).toBe(false);
      expect((tool as unknown as Record<string, unknown>)['parameters']).toBeUndefined();
    }
  });

  it('mechanically aligns declarations with shared Zod parameter schemas for all five tools', () => {
    for (const toolName of expectedToolNames) {
      const declaration = GEMINI_TOOL_DECLARATIONS.find((t) => t.name === toolName);
      expect(declaration).toBeDefined();

      const zodSchema = TOOL_PARAM_SCHEMAS[toolName];
      expect(zodSchema).toBeDefined();
    }
  });

  it('normalizes literal const values to SDK-compatible single-value enums across all schemas', () => {
    for (const tool of GEMINI_TOOL_DECLARATIONS) {
      checkNoConst(tool.parametersJsonSchema);
    }
  });

  it('verifies the actual Gemini SDK function declaration request structure', () => {
    const formattedTools = [{ functionDeclarations: GEMINI_TOOL_DECLARATIONS }];
    const toolGroup = formattedTools[0]!;
    expect(toolGroup.functionDeclarations).toHaveLength(5);
    for (const fd of toolGroup.functionDeclarations) {
      expect(typeof fd.name).toBe('string');
      expect(typeof fd.description).toBe('string');
      expect(typeof fd.parametersJsonSchema).toBe('object');
      expect((fd as unknown as Record<string, unknown>)['parameters']).toBeUndefined();
    }
  });

  it('detects required properties, enum values, bounds, and string constraints accurately', () => {
    // 1. recommend_response_plan
    const planTool = GEMINI_TOOL_DECLARATIONS.find((t) => t.name === 'recommend_response_plan')!;
    expect(planTool.parametersJsonSchema.required).toEqual([
      'eventId',
      'recommendedActions',
      'rationale',
      'confidence',
    ]);
    const planProps = planTool.parametersJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(planProps['confidence']?.['minimum']).toBe(0);
    expect(planProps['confidence']?.['maximum']).toBe(1);
    expect(planProps['rationale']?.['minLength']).toBe(1);
    expect(planProps['rationale']?.['maxLength']).toBe(500);
    expect(planProps['recommendedActions']?.['minItems']).toBe(1);
    expect(planProps['recommendedActions']?.['maxItems']).toBe(5);

    // 2. request_decoy_deployment
    const decoyTool = GEMINI_TOOL_DECLARATIONS.find((t) => t.name === 'request_decoy_deployment')!;
    expect(decoyTool.parametersJsonSchema.required).toEqual([
      'eventId',
      'templateName',
      'region',
      'ttlSeconds',
      'reason',
    ]);
    const decoyProps = decoyTool.parametersJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(decoyProps['templateName']?.['enum']).toEqual([
      'mock-admin-decoy',
      'mock-wordpress-decoy',
    ]);
    expect(decoyProps['region']?.['enum']).toEqual(['us-central1']);
    expect(decoyProps['region']?.['const']).toBeUndefined();
    expect(decoyProps['ttlSeconds']?.['minimum']).toBe(60);
    expect(decoyProps['ttlSeconds']?.['maximum']).toBe(3600);

    // 3. request_false_route_assignment
    const routeTool = GEMINI_TOOL_DECLARATIONS.find(
      (t) => t.name === 'request_false_route_assignment',
    )!;
    expect(routeTool.parametersJsonSchema.required).toEqual([
      'eventId',
      'sourceIp',
      'targetDecoyService',
      'ttlSeconds',
      'reason',
    ]);
    const routeProps = routeTool.parametersJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(routeProps['targetDecoyService']?.['maxLength']).toBe(128);

    // 4. request_source_quarantine
    const quarantineTool = GEMINI_TOOL_DECLARATIONS.find(
      (t) => t.name === 'request_source_quarantine',
    )!;
    expect(quarantineTool.parametersJsonSchema.required).toEqual([
      'eventId',
      'sourceIp',
      'cidrPrefix',
      'ttlSeconds',
      'reason',
    ]);
    const quarantineProps = quarantineTool.parametersJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(quarantineProps['cidrPrefix']?.['anyOf']).toBeDefined();

    // 5. request_operator_alert
    const alertTool = GEMINI_TOOL_DECLARATIONS.find((t) => t.name === 'request_operator_alert')!;
    expect(alertTool.parametersJsonSchema.required).toEqual([
      'eventId',
      'severity',
      'headline',
      'details',
    ]);
    const alertProps = alertTool.parametersJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(alertProps['severity']?.['enum']).toEqual(['INFO', 'WARNING', 'HIGH', 'CRITICAL']);
    expect(alertProps['headline']?.['maxLength']).toBe(256);
    expect(alertProps['details']?.['maxLength']).toBe(1000);
  });

  it('validates schema compliance for valid and invalid fixtures across all tools', () => {
    const validUuid = '11111111-1111-4111-8111-111111111111';

    // Valid fixtures
    expect(
      TOOL_PARAM_SCHEMAS['recommend_response_plan'].safeParse({
        eventId: validUuid,
        recommendedActions: ['DEPLOY_DECOY'],
        rationale: 'Valid rationale',
        confidence: 0.9,
      }).success,
    ).toBe(true);

    expect(
      TOOL_PARAM_SCHEMAS['request_decoy_deployment'].safeParse({
        eventId: validUuid,
        templateName: 'mock-admin-decoy',
        region: 'us-central1',
        ttlSeconds: 300,
        reason: 'Deploy decoy',
      }).success,
    ).toBe(true);

    expect(
      TOOL_PARAM_SCHEMAS['request_false_route_assignment'].safeParse({
        eventId: validUuid,
        sourceIp: '198.51.100.25',
        targetDecoyService: 'mock-admin-decoy',
        ttlSeconds: 300,
        reason: 'Divert traffic',
      }).success,
    ).toBe(true);

    expect(
      TOOL_PARAM_SCHEMAS['request_source_quarantine'].safeParse({
        eventId: validUuid,
        sourceIp: '198.51.100.25',
        cidrPrefix: 32,
        ttlSeconds: 300,
        reason: 'Quarantine source',
      }).success,
    ).toBe(true);

    expect(
      TOOL_PARAM_SCHEMAS['request_operator_alert'].safeParse({
        eventId: validUuid,
        severity: 'HIGH',
        headline: 'Alert headline',
        details: 'Alert details',
      }).success,
    ).toBe(true);

    // Invalid fixtures (extra field / out-of-bounds)
    expect(
      TOOL_PARAM_SCHEMAS['recommend_response_plan'].safeParse({
        eventId: validUuid,
        recommendedActions: ['DEPLOY_DECOY'],
        rationale: 'Valid rationale',
        confidence: 1.5, // > 1
      }).success,
    ).toBe(false);

    expect(
      TOOL_PARAM_SCHEMAS['request_decoy_deployment'].safeParse({
        eventId: validUuid,
        templateName: 'unallowlisted-template',
        region: 'us-central1',
        ttlSeconds: 300,
        reason: 'Deploy decoy',
      }).success,
    ).toBe(false);

    expect(
      TOOL_PARAM_SCHEMAS['request_decoy_deployment'].safeParse({
        eventId: validUuid,
        templateName: 'mock-admin-decoy',
        region: 'us-central1',
        ttlSeconds: 300,
        reason: 'Deploy decoy',
        unknownProperty: 'arbitrary-injected-field', // additionalProperties: false
      }).success,
    ).toBe(false);
  });
});
