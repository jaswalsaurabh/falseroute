import { describe, expect, it, vi } from 'vitest';
import { CampaignRepository } from './campaign-repository.js';

describe('CampaignRepository.markPublished', () => {
  it('finalizes a recovered publishing claim only for its owner', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new CampaignRepository({
      campaignStepRun: { updateMany },
    } as never);

    await expect(repository.markPublished('event-2', 'campaign-worker-1')).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        eventId: 'event-2',
        publishedAt: null,
        OR: [
          { status: 'READY', claimOwner: null },
          { status: 'PUBLISHING', claimOwner: 'campaign-worker-1' },
        ],
      },
      data: {
        status: 'PUBLISHED',
        publishedAt: expect.any(Date),
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
  });

  it('keeps the original ready-publication transition compatible', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new CampaignRepository({
      campaignStepRun: { updateMany },
    } as never);

    await expect(repository.markPublished('event-1')).resolves.toBe(true);

    expect(updateMany.mock.calls[0]?.[0].where.OR).toEqual([{ status: 'READY', claimOwner: null }]);
  });
});
