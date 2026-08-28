import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '../generated/client/client.js';

export interface CampaignStepInput {
  readonly eventId: string;
  readonly scenarioKind: string;
  readonly label: string;
  readonly sourceIp: string;
  readonly evidence: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface CampaignInitialEventInput {
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly sourceIp: string;
  readonly evidence: Record<string, unknown>;
}

export interface CampaignRunRecord {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly status: string;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly correlationId: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly failureReason: string | null;
}

export interface CampaignPublication {
  readonly campaignId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly step: number;
  readonly scenarioKind: string;
  readonly label: string;
  readonly sourceIp: string;
  readonly evidence: Record<string, unknown>;
  readonly occurredAt: Date;
}

export type CampaignAdvanceResult =
  | { readonly disposition: 'ADVANCED'; readonly publication: CampaignPublication }
  | { readonly disposition: 'COMPLETED' }
  | { readonly disposition: 'FAILED' }
  | { readonly disposition: 'DUPLICATE' };

function toCampaignRun(value: {
  id: string;
  definitionId: string;
  definitionVersion: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  correlationId: string;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}): CampaignRunRecord {
  return value;
}

export class CampaignRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async startInitialCampaign(correlationId: string): Promise<CampaignRunRecord> {
    const existing = await this.prisma.campaignRun.findUnique({
      where: { definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN' },
    });
    if (existing) return toCampaignRun(existing);

    try {
      const created = await this.prisma.campaignRun.create({
        data: {
          definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN',
          definitionVersion: '1.0.0',
          status: 'RUNNING',
          currentStep: 0,
          totalSteps: 4,
          correlationId,
          startedAt: new Date(),
        },
      });
      return toCampaignRun(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.campaignRun.findUniqueOrThrow({
        where: { definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN' },
      });
      return toCampaignRun(raced);
    }
  }

  async getCampaign(id: string): Promise<CampaignRunRecord | null> {
    const campaign = await this.prisma.campaignRun.findUnique({ where: { id } });
    return campaign ? toCampaignRun(campaign) : null;
  }

  async listResumableCampaignIds(): Promise<readonly string[]> {
    const campaigns = await this.prisma.campaignRun.findMany({
      where: {
        status: 'RUNNING',
        steps: { some: { status: { in: ['READY', 'PUBLISHING'] } } },
      },
      select: { id: true },
    });
    return campaigns.map((campaign) => campaign.id);
  }

  async ensureInitialEvent(input: CampaignInitialEventInput): Promise<void> {
    await this.prisma.intrusionEvent.upsert({
      where: { id: input.eventId },
      create: {
        id: input.eventId,
        occurredAt: input.occurredAt,
        receivedAt: new Date(),
        correlationId: input.correlationId,
        sourceIp: input.sourceIp,
        targetAsset: 'mock-admin-portal',
        eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        failedLoginCount: 1,
        riskIndicators: ['ENV_FILE_PROBE'],
        containmentMode: 'SIMULATED',
        usedDecoyCredential: false,
        scenarioKind: 'ENV_FILE_PROBE',
        evidence: input.evidence as Prisma.InputJsonValue,
        status: 'PENDING',
        provenance: 'OBSERVED',
      },
      update: {},
    });
  }

  async ensureInitialStep(
    input: CampaignStepInput & { readonly correlationId: string },
  ): Promise<boolean> {
    const existing = await this.prisma.campaignStepRun.findUnique({
      where: { eventId: input.eventId },
    });
    if (existing) return false;

    const campaign = await this.prisma.campaignRun.findUniqueOrThrow({
      where: { correlationId: input.correlationId },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.campaignStepRun.create({
        data: {
          campaignId: campaign.id,
          step: 1,
          scenarioKind: input.scenarioKind,
          label: input.label,
          eventId: input.eventId,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      await tx.campaignRun.updateMany({
        where: { id: campaign.id, status: 'RUNNING', currentStep: 0 },
        data: { currentStep: 1 },
      });
    });
    return true;
  }

  async completeAndPrepareNext(params: {
    readonly eventId: string;
    readonly ownerId: string;
    readonly next?: CampaignStepInput;
  }): Promise<CampaignAdvanceResult> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const step = await tx.campaignStepRun.findUnique({
        where: { eventId: params.eventId },
        include: { campaign: true },
      });
      if (!step) return { disposition: 'DUPLICATE' };

      const claimed = await tx.campaignRun.updateMany({
        where: {
          id: step.campaignId,
          status: 'RUNNING',
          currentStep: step.step,
          OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        },
        data: { claimOwner: params.ownerId, claimExpiresAt: new Date(now.getTime() + 30_000) },
      });
      if (claimed.count !== 1) return { disposition: 'DUPLICATE' };

      await tx.campaignStepRun.update({
        where: { id: step.id },
        data: { status: 'COMPLETED', completedAt: now, claimOwner: null, claimExpiresAt: null },
      });

      if (!params.next) {
        await tx.campaignRun.update({
          where: { id: step.campaignId },
          data: {
            status: 'COMPLETED',
            currentStep: step.step,
            completedAt: now,
            claimOwner: null,
            claimExpiresAt: null,
          },
        });
        return { disposition: 'COMPLETED' };
      }

      const eventId = params.next.eventId || randomUUID();
      await tx.intrusionEvent.create({
        data: {
          id: eventId,
          occurredAt: params.next.occurredAt,
          receivedAt: now,
          correlationId: step.campaign.correlationId,
          sourceIp: params.next.sourceIp,
          targetAsset: 'mock-admin-portal',
          eventType:
            params.next.scenarioKind === 'DECOY_CREDENTIAL_USE'
              ? 'UNAUTHORIZED_ACCESS_ATTEMPT'
              : 'UNAUTHORIZED_ACCESS_ATTEMPT',
          failedLoginCount: params.next.scenarioKind === 'DECOY_CREDENTIAL_USE' ? 3 : 1,
          riskIndicators: [params.next.scenarioKind],
          containmentMode: 'SIMULATED',
          usedDecoyCredential: params.next.scenarioKind === 'DECOY_CREDENTIAL_USE',
          ...(params.next.scenarioKind === 'DECOY_CREDENTIAL_USE'
            ? { decoyIdentifier: 'mock-admin-decoy-creds' }
            : {}),
          scenarioKind: params.next.scenarioKind,
          evidence: params.next.evidence as Prisma.InputJsonValue,
          status: 'PENDING',
          provenance: 'OBSERVED',
        },
      });
      await tx.campaignStepRun.create({
        data: {
          campaignId: step.campaignId,
          step: step.step + 1,
          scenarioKind: params.next.scenarioKind,
          label: params.next.label,
          eventId,
          status: 'READY',
        },
      });
      await tx.campaignRun.update({
        where: { id: step.campaignId },
        data: { currentStep: step.step + 1, claimOwner: null, claimExpiresAt: null },
      });
      return {
        disposition: 'ADVANCED',
        publication: {
          campaignId: step.campaignId,
          eventId,
          correlationId: step.campaign.correlationId,
          step: step.step + 1,
          scenarioKind: params.next.scenarioKind,
          label: params.next.label,
          sourceIp: params.next.sourceIp,
          evidence: params.next.evidence,
          occurredAt: params.next.occurredAt,
        },
      };
    });
  }

  async markPublished(eventId: string, claimOwner?: string): Promise<boolean> {
    const result = await this.prisma.campaignStepRun.updateMany({
      where: {
        eventId,
        publishedAt: null,
        OR: [
          { status: 'READY', claimOwner: null },
          ...(claimOwner ? [{ status: 'PUBLISHING', claimOwner }] : []),
        ],
      },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  async claimReadyPublication(
    campaignId: string,
    ownerId: string,
  ): Promise<CampaignPublication | null> {
    const now = new Date();
    const claimed = await this.prisma.campaignStepRun.updateMany({
      where: {
        campaignId,
        status: { in: ['READY', 'PUBLISHING'] },
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
      },
      data: {
        status: 'PUBLISHING',
        claimOwner: ownerId,
        claimExpiresAt: new Date(now.getTime() + 30_000),
      },
    });
    if (claimed.count !== 1) return null;
    const step = await this.prisma.campaignStepRun.findFirstOrThrow({
      where: { campaignId, status: 'PUBLISHING', claimOwner: ownerId },
      include: { campaign: true, event: true },
      orderBy: { step: 'asc' },
    });
    return {
      campaignId,
      eventId: step.eventId,
      correlationId: step.campaign.correlationId,
      step: step.step,
      scenarioKind: step.scenarioKind,
      label: step.label,
      sourceIp: step.event.sourceIp,
      evidence: (step.event.evidence ?? {}) as Record<string, unknown>,
      occurredAt: step.event.occurredAt,
    };
  }

  async failCampaign(eventId: string, reason: string): Promise<boolean> {
    const step = await this.prisma.campaignStepRun.findUnique({ where: { eventId } });
    if (!step) return false;
    const result = await this.prisma.campaignRun.updateMany({
      where: { id: step.campaignId, status: 'RUNNING', currentStep: step.step },
      data: { status: 'FAILED', failureReason: reason.slice(0, 512), completedAt: new Date() },
    });
    if (result.count !== 1) return false;
    await this.prisma.campaignStepRun.update({
      where: { id: step.id },
      data: { status: 'FAILED', failureReason: reason.slice(0, 512), completedAt: new Date() },
    });
    return true;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
