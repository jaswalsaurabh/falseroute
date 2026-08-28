import { describe, expect, it, vi } from 'vitest';
import { type ActivityEventRepository, type CampaignRepository } from '@false-route/database';
import { type IntrusionEventEnvelope } from '@false-route/contracts';
import { CampaignOrchestrator } from './campaign-orchestrator.js';
import { type AutonomousWorkflowOrchestrator } from './autonomous-workflow.js';

const envelope: IntrusionEventEnvelope = {
  eventId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'campaign-correlation',
  schemaVersion: '1.0.0',
  source: 'OPERATOR',
  scenarioKind: 'ENV_FILE_PROBE',
  occurredAt: '2026-08-24T00:00:00.000Z',
  publishedAt: '2026-08-24T00:00:01.000Z',
  sourceIp: '192.0.2.10',
  evidence: {
    scenarioKind: 'ENV_FILE_PROBE',
    requestedPath: '/.env',
    httpMethod: 'GET',
    userAgent: 'FalseRoute-campaign/1.0.0',
    sourceIp: '192.0.2.10',
    matchedString: 'DATABASE_URL=not-a-real-campaign-value',
    isPositiveMatch: true,
  },
  provenance: 'OBSERVED',
};

describe('CampaignOrchestrator', () => {
  it('advances only after the workflow completes and publishes the fixed next step once', async () => {
    const campaigns = {
      ensureInitialStep: vi.fn().mockResolvedValue(true),
      completeAndPrepareNext: vi.fn().mockResolvedValue({
        disposition: 'ADVANCED',
        publication: {
          campaignId: '22222222-2222-4222-8222-222222222222',
          eventId: '33333333-3333-4333-8333-333333333333',
          correlationId: envelope.correlationId,
          step: 2,
          scenarioKind: 'PATH_TRAVERSAL_PROBE',
          label: 'Path traversal probe',
          sourceIp: '192.0.2.10',
          evidence: {
            scenarioKind: 'PATH_TRAVERSAL_PROBE',
            requestedPath: '/../../etc/passwd',
            httpMethod: 'GET',
            userAgent: 'FalseRoute-campaign/1.0.0',
            sourceIp: '192.0.2.10',
            isPositiveMatch: true,
          },
          occurredAt: new Date('2026-08-24T00:00:02.000Z'),
        },
      }),
      markPublished: vi.fn().mockResolvedValue(true),
      failCampaign: vi.fn(),
    } as unknown as CampaignRepository;
    const activity = { recordActivityEvent: vi.fn() } as unknown as ActivityEventRepository;
    const publisher = { publish: vi.fn().mockResolvedValue({ transportId: 'transport-2' }) };
    const workflow = {
      processEventEnvelope: vi.fn().mockResolvedValue({ status: 'COMPLETED' }),
    } as unknown as AutonomousWorkflowOrchestrator;
    const orchestrator = new CampaignOrchestrator(campaigns, activity, publisher, workflow);

    await orchestrator.process(envelope, 'transport-1');

    expect(campaigns.completeAndPrepareNext).toHaveBeenCalledOnce();
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(campaigns.markPublished).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
    expect(activity.recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'CAMPAIGN_STEP_PUBLISHED' }),
    );
  });

  it('makes workflow failure terminal and does not publish a next step', async () => {
    const campaigns = {
      ensureInitialStep: vi.fn().mockResolvedValue(true),
      completeAndPrepareNext: vi.fn(),
      markPublished: vi.fn(),
      failCampaign: vi.fn().mockResolvedValue(true),
    } as unknown as CampaignRepository;
    const activity = { recordActivityEvent: vi.fn() } as unknown as ActivityEventRepository;
    const publisher = { publish: vi.fn() };
    const workflow = {
      processEventEnvelope: vi.fn().mockResolvedValue({ status: 'FAILED' }),
    } as unknown as AutonomousWorkflowOrchestrator;
    const orchestrator = new CampaignOrchestrator(campaigns, activity, publisher, workflow);

    await orchestrator.process(envelope, 'transport-1');

    expect(campaigns.failCampaign).toHaveBeenCalledOnce();
    expect(campaigns.completeAndPrepareNext).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(activity.recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'CAMPAIGN_FAILED' }),
    );
  });

  it('resumes a durable ready step without processing the preceding event again', async () => {
    const campaigns = {
      listResumableCampaignIds: vi.fn().mockResolvedValue(['22222222-2222-4222-8222-222222222222']),
      claimReadyPublication: vi.fn().mockResolvedValue({
        campaignId: '22222222-2222-4222-8222-222222222222',
        eventId: '33333333-3333-4333-8333-333333333333',
        correlationId: envelope.correlationId,
        step: 2,
        scenarioKind: 'PATH_TRAVERSAL_PROBE',
        label: 'Path traversal probe',
        sourceIp: '192.0.2.10',
        evidence: {
          scenarioKind: 'PATH_TRAVERSAL_PROBE',
          requestedPath: '/../../etc/passwd',
          httpMethod: 'GET',
          userAgent: 'FalseRoute-campaign/1.0.0',
          sourceIp: '192.0.2.10',
          isPositiveMatch: true,
        },
        occurredAt: new Date('2026-08-24T00:00:02.000Z'),
      }),
      markPublished: vi.fn().mockResolvedValue(true),
    } as unknown as CampaignRepository;
    const activity = { recordActivityEvent: vi.fn() } as unknown as ActivityEventRepository;
    const publisher = { publish: vi.fn().mockResolvedValue({ transportId: 'transport-2' }) };
    const workflow = { processEventEnvelope: vi.fn() } as unknown as AutonomousWorkflowOrchestrator;
    const orchestrator = new CampaignOrchestrator(campaigns, activity, publisher, workflow);

    await orchestrator.resumeReadyCampaigns();

    expect(campaigns.claimReadyPublication).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      expect.stringMatching(/^campaign-worker-/),
    );
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(workflow.processEventEnvelope).not.toHaveBeenCalled();
  });
});
