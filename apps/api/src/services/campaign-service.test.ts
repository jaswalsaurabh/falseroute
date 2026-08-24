import { describe, expect, it, vi } from 'vitest';
import { type CampaignRepository } from '@false-route/database';
import { CampaignService } from './campaign-service.js';

const campaign = {
  id: '11111111-1111-4111-8111-111111111111',
  definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN',
  definitionVersion: '1.0.0',
  status: 'RUNNING',
  currentStep: 0,
  totalSteps: 4,
  correlationId: 'campaign-correlation',
  startedAt: new Date('2026-08-24T00:00:00.000Z'),
  completedAt: null,
  failureReason: null,
};

describe('CampaignService', () => {
  it('starts the fixed campaign and publishes the first synthetic step', async () => {
    const repository = {
      startInitialCampaign: vi.fn().mockResolvedValue(campaign),
      getCampaign: vi.fn(),
    } as unknown as CampaignRepository;
    const publisher = { publish: vi.fn().mockResolvedValue({ transportId: 'transport-1' }) };
    const service = new CampaignService(repository, publisher);

    const result = await service.start('campaign-correlation');

    expect(result.status).toBe('RUNNING');
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(publisher.publish.mock.calls[0]?.[0]).toMatchObject({
      eventId: campaign.id,
      scenarioKind: 'ENV_FILE_PROBE',
      source: 'OPERATOR',
    });
  });
});
