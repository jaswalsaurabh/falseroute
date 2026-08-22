import { describe, it, expect } from 'vitest';
import {
  ToolNameSchema,
  ToolExecutionStageSchema,
  RecommendResponsePlanParamsSchema,
  RequestDecoyDeploymentParamsSchema,
  RequestFalseRouteAssignmentParamsSchema,
  RequestSourceQuarantineParamsSchema,
  RequestOperatorAlertParamsSchema,
  ToolResultSchema,
} from './tool-execution.js';

describe('Tool Execution Contracts', () => {
  it('validates closed tool catalog names and execution stages', () => {
    expect(ToolNameSchema.safeParse('recommend_response_plan').success).toBe(true);
    expect(ToolNameSchema.safeParse('request_decoy_deployment').success).toBe(true);
    expect(ToolNameSchema.safeParse('request_false_route_assignment').success).toBe(true);
    expect(ToolNameSchema.safeParse('request_source_quarantine').success).toBe(true);
    expect(ToolNameSchema.safeParse('request_operator_alert').success).toBe(true);
    expect(ToolNameSchema.safeParse('unrestricted_shell_command').success).toBe(false);

    expect(ToolExecutionStageSchema.safeParse('REQUESTED').success).toBe(true);
    expect(ToolExecutionStageSchema.safeParse('AUTHORIZED').success).toBe(true);
    expect(ToolExecutionStageSchema.safeParse('FAKE_EXECUTED').success).toBe(true);
    expect(ToolExecutionStageSchema.safeParse('EXECUTED').success).toBe(true);
    expect(ToolExecutionStageSchema.safeParse('ROLLED_BACK').success).toBe(true);
  });

  it('validates RecommendResponsePlanParamsSchema and RequestOperatorAlertParamsSchema', () => {
    const plan = {
      eventId: '11111111-1111-4111-8111-111111111111',
      recommendedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      rationale: 'Recommending decoy diversion for configuration scan',
      confidence: 0.95,
    };
    expect(RecommendResponsePlanParamsSchema.safeParse(plan).success).toBe(true);

    const alert = {
      eventId: '11111111-1111-4111-8111-111111111111',
      severity: 'CRITICAL',
      headline: 'Incident Alert',
      details: 'High severity incident detected',
    };
    expect(RequestOperatorAlertParamsSchema.safeParse(alert).success).toBe(true);
  });

  it('validates RequestDecoyDeploymentParamsSchema and RequestFalseRouteAssignmentParamsSchema', () => {
    const validDecoy = {
      eventId: '11111111-1111-4111-8111-111111111111',
      templateName: 'mock-admin-decoy',
      region: 'us-central1',
      ttlSeconds: 300,
      reason: 'Deploying isolated admin decoy for containment',
    };
    expect(RequestDecoyDeploymentParamsSchema.safeParse(validDecoy).success).toBe(true);

    const validRoute = {
      eventId: '11111111-1111-4111-8111-111111111111',
      sourceIp: '198.51.100.25',
      targetDecoyService: 'mock-admin-decoy',
      ttlSeconds: 300,
      reason: 'Diverting suspicious probe traffic',
    };
    expect(RequestFalseRouteAssignmentParamsSchema.safeParse(validRoute).success).toBe(true);
  });

  it('validates RequestSourceQuarantineParamsSchema strictly', () => {
    const validV4 = {
      eventId: '11111111-1111-4111-8111-111111111111',
      sourceIp: '198.51.100.25',
      cidrPrefix: 32,
      ttlSeconds: 600,
      reason: 'Volumetric burst threshold exceeded',
    };
    expect(RequestSourceQuarantineParamsSchema.safeParse(validV4).success).toBe(true);

    const invalidPrefix = { ...validV4, cidrPrefix: 24 }; // Broad CIDR rejected
    expect(RequestSourceQuarantineParamsSchema.safeParse(invalidPrefix).success).toBe(false);
  });

  it('validates ToolResultSchema with idempotencyKey and execution stage', () => {
    const validResult = {
      toolCallId: 'call-dummy-1234',
      toolName: 'request_decoy_deployment',
      stage: 'FAKE_EXECUTED',
      idempotencyKey: 'idem-dummy-11111111-1111-4111-8111-111111111111-deploy',
      authorized: true,
      policyReason: 'Policy POLICY_ENV_PROBE_CONTAINMENT authorized decoy deployment',
      providerResourceId: 'cr-decoy-dummy-01',
      executedAt: '2026-08-22T10:00:05.000Z',
    };
    expect(ToolResultSchema.safeParse(validResult).success).toBe(true);
  });
});
