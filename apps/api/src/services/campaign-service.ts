import { CampaignRunSchema } from '@false-route/contracts';
import { type CampaignRepository, type CampaignRunRecord } from '@false-route/database';
import { type EventPublisher } from '../integrations/event-publisher.js';
import { NotFoundError } from '../middleware/error-handler.js';

const SOURCE_IP = '192.0.2.10';

export class CampaignService {
  constructor(
    private readonly repository: CampaignRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async start(correlationId: string) {
    const campaign = await this.repository.startInitialCampaign(correlationId);
    // A campaign already past step zero owns its initial publication. This keeps
    // duplicate operator starts from creating another transport delivery.
    if (campaign.currentStep === 0) {
      await this.publisher.publish({
        eventId: campaign.id,
        correlationId: campaign.correlationId,
        schemaVersion: '1.0.0',
        source: 'OPERATOR',
        scenarioKind: 'ENV_FILE_PROBE',
        occurredAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        sourceIp: SOURCE_IP,
        evidence: {
          scenarioKind: 'ENV_FILE_PROBE',
          requestedPath: '/.env',
          httpMethod: 'GET',
          userAgent: 'FalseRoute-campaign/1.0.0',
          sourceIp: SOURCE_IP,
          matchedString: 'DATABASE_URL=not-a-real-campaign-value',
          isPositiveMatch: true,
        },
        provenance: 'OBSERVED',
      });
    }
    return CampaignRunSchema.parse(toContract(campaign));
  }

  async get(id: string) {
    const campaign = await this.repository.getCampaign(id);
    if (!campaign) throw new NotFoundError(`Campaign not found: ${id}`);
    return CampaignRunSchema.parse(toContract(campaign));
  }
}

function toContract(campaign: CampaignRunRecord) {
  return {
    campaignId: campaign.id,
    definitionId: campaign.definitionId,
    definitionVersion: campaign.definitionVersion,
    status: campaign.status,
    currentStep: campaign.currentStep,
    totalSteps: campaign.totalSteps,
    correlationId: campaign.correlationId,
    ...(campaign.startedAt ? { startedAt: campaign.startedAt.toISOString() } : {}),
    ...(campaign.completedAt ? { completedAt: campaign.completedAt.toISOString() } : {}),
  };
}
