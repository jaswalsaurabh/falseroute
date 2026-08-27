import { randomUUID } from 'node:crypto';
import {
  INITIAL_CAMPAIGN_STEPS,
  IntrusionEventEnvelopeSchema,
  type IntrusionEventEnvelope,
} from '@false-route/contracts';
import { type CampaignRepository, type ActivityEventRepository } from '@false-route/database';
import { AutonomousWorkflowOrchestrator } from './autonomous-workflow.js';

const SOURCE_IP = '192.0.2.10';

export interface CampaignEventPublisher {
  publish(envelope: IntrusionEventEnvelope): Promise<{ readonly transportId: string }>;
}

export class CampaignOrchestrator {
  private readonly ownerId = `campaign-worker-${randomUUID()}`;

  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly activity: ActivityEventRepository,
    private readonly publisher: CampaignEventPublisher,
    private readonly workflow: AutonomousWorkflowOrchestrator,
  ) {}

  async process(envelope: IntrusionEventEnvelope, transportId: string): Promise<void> {
    const result = await this.workflow.processEventEnvelope(envelope, transportId);
    const step = INITIAL_CAMPAIGN_STEPS.find(
      (candidate) => candidate.scenarioKind === envelope.scenarioKind,
    );
    if (!step) return;

    if (step.step === 1) {
      const first = await this.campaigns.ensureInitialStep({
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        scenarioKind: step.scenarioKind,
        label: step.label,
        sourceIp: envelope.sourceIp,
        evidence: envelope.evidence,
        occurredAt: new Date(envelope.occurredAt),
      });
      if (first) {
        await this.activity.recordActivityEvent({
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          stage: 'RECEIVED',
          eventType: 'CAMPAIGN_STARTED',
          summary: 'Initial autonomous campaign started; subsequent steps are system-owned',
          provenance: 'DERIVED',
        });
      }
    }

    if (result.status === 'FAILED') {
      await this.campaigns.failCampaign(envelope.eventId, 'Campaign step workflow failed');
      await this.activity.recordActivityEvent({
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        stage: 'FAILED',
        eventType: 'CAMPAIGN_FAILED',
        summary: `Autonomous campaign failed at step ${step.step}`,
        provenance: 'DERIVED',
      });
      return;
    }

    const nextStep = INITIAL_CAMPAIGN_STEPS[step.step];
    const advance = await this.campaigns.completeAndPrepareNext({
      eventId: envelope.eventId,
      ownerId: this.ownerId,
      ...(nextStep
        ? {
            next: {
              eventId: randomUUID(),
              scenarioKind: nextStep.scenarioKind,
              label: nextStep.label,
              sourceIp: SOURCE_IP,
              occurredAt: new Date(),
              evidence: evidenceFor(nextStep.scenarioKind),
            },
          }
        : {}),
    });

    if (advance.disposition === 'ADVANCED') {
      await this.publish(envelope.eventId, envelope.correlationId, advance.publication);
    } else if (advance.disposition === 'COMPLETED') {
      await this.activity.recordActivityEvent({
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        stage: 'COMPLETED',
        eventType: 'CAMPAIGN_COMPLETED',
        summary: 'Initial autonomous campaign completed in simulated mode',
        provenance: 'DERIVED',
      });
    }
  }

  async resume(campaignId: string): Promise<boolean> {
    const publication = await this.campaigns.claimReadyPublication(campaignId, this.ownerId);
    if (!publication) return false;
    await this.publish(publication.eventId, publication.correlationId, publication);
    return true;
  }

  private async publish(
    currentEventId: string,
    correlationId: string,
    publication: {
      readonly eventId: string;
      readonly correlationId: string;
      readonly scenarioKind: string;
      readonly sourceIp: string;
      readonly evidence: Record<string, unknown>;
      readonly occurredAt: Date;
      readonly step: number;
    },
  ): Promise<void> {
    const envelope = IntrusionEventEnvelopeSchema.parse({
      eventId: publication.eventId,
      correlationId,
      schemaVersion: '1.0.0',
      source: 'WORKER',
      scenarioKind: publication.scenarioKind,
      occurredAt: publication.occurredAt.toISOString(),
      publishedAt: new Date().toISOString(),
      sourceIp: publication.sourceIp,
      evidence: publication.evidence,
      provenance: 'OBSERVED',
    });
    await this.publisher.publish(envelope);
    await this.campaigns.markPublished(publication.eventId);
    await this.activity.recordActivityEvent({
      eventId: currentEventId,
      correlationId,
      stage: 'EXECUTING',
      eventType: 'CAMPAIGN_STEP_PUBLISHED',
      summary: `Published fixed autonomous campaign step ${publication.step} (${publication.scenarioKind})`,
      provenance: 'DERIVED',
    });
  }
}

function evidenceFor(scenarioKind: string): Record<string, unknown> {
  if (scenarioKind === 'PATH_TRAVERSAL_PROBE') {
    return {
      scenarioKind,
      requestedPath: '/../../etc/passwd',
      httpMethod: 'GET',
      userAgent: 'FalseRoute-campaign/1.0.0',
      sourceIp: SOURCE_IP,
      isPositiveMatch: true,
    };
  }
  if (scenarioKind === 'SQL_INJECTION_PROBE') {
    return {
      scenarioKind,
      sourceIp: SOURCE_IP,
      requestedPath: '/search',
      parameterName: 'q',
      detectionSignal: 'SQL_SYNTAX_MARKER',
      isPositiveMatch: true,
    };
  }
  return {
    scenarioKind: 'DECOY_CREDENTIAL_USE',
    sourceIp: SOURCE_IP,
    usedDecoyCredential: true,
    decoyIdentifier: 'mock-admin-decoy',
    targetAsset: 'mock-admin-portal',
    failedLoginCount: 3,
    isPositiveMatch: true,
  };
}
