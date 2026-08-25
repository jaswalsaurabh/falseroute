import { describe, expect, it } from 'vitest';
import { CampaignRunSchema, INITIAL_CAMPAIGN_STEPS } from './campaign.js';

describe('AI campaign contracts', () => {
  it('defines the fixed synthetic campaign in order', () => {
    expect(INITIAL_CAMPAIGN_STEPS.map((step) => step.scenarioKind)).toEqual([
      'ENV_FILE_PROBE',
      'PATH_TRAVERSAL_PROBE',
      'SQL_INJECTION_PROBE',
      'DECOY_CREDENTIAL_USE',
    ]);
  });

  it('rejects impossible campaign bounds and unknown keys', () => {
    const run = {
      campaignId: '22222222-2222-4222-8222-222222222222',
      definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN' as const,
      definitionVersion: '1.0.0',
      status: 'COMPLETED' as const,
      currentStep: 4,
      totalSteps: 4,
      correlationId: 'campaign-not-a-real-001',
      startedAt: '2026-08-24T00:00:00.000Z',
      completedAt: '2026-08-24T00:01:00.000Z',
    };
    expect(CampaignRunSchema.safeParse(run).success).toBe(true);
    expect(CampaignRunSchema.safeParse({ ...run, currentStep: 5 }).success).toBe(false);
    expect(CampaignRunSchema.safeParse({ ...run, unknown: 'dummy' }).success).toBe(false);
  });
});
