import type { PrismaClient, Prisma, ProvenanceClassification } from '../generated/client/client.js';

export interface ActivityEventRecordItem {
  readonly cursor: number;
  readonly id: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly stage: string;
  readonly eventType: string;
  readonly summary: string;
  readonly provenance: ProvenanceClassification;
  readonly payload?: Record<string, unknown> | null | undefined;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export class ActivityEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordActivityEvent(params: {
    eventId: string;
    correlationId: string;
    stage: string;
    eventType: string;
    summary: string;
    provenance: ProvenanceClassification;
    payload?: Record<string, unknown>;
    occurredAt?: Date;
  }): Promise<ActivityEventRecordItem> {
    const created = await this.prisma.activityEventRecord.create({
      data: {
        eventId: params.eventId,
        correlationId: params.correlationId,
        stage: params.stage,
        eventType: params.eventType,
        summary: params.summary.slice(0, 500),
        provenance: params.provenance,
        payload: (params.payload as unknown as Prisma.InputJsonValue) ?? undefined,
        occurredAt: params.occurredAt ?? new Date(),
      },
    });

    return created as ActivityEventRecordItem;
  }

  async getEventsSince(afterCursor: number, limit = 50): Promise<ActivityEventRecordItem[]> {
    return this.getEventsBetween(afterCursor, undefined, limit);
  }

  async getEventsBetween(
    afterCursor: number,
    throughCursor: number | undefined,
    limit = 50,
  ): Promise<ActivityEventRecordItem[]> {
    const events = await this.prisma.activityEventRecord.findMany({
      where: {
        cursor: {
          gt: afterCursor,
          ...(throughCursor === undefined ? {} : { lte: throughCursor }),
        },
      },
      orderBy: { cursor: 'asc' },
      take: Math.min(limit, 100),
    });

    return events as ActivityEventRecordItem[];
  }

  async getLatestEvents(limit = 50): Promise<ActivityEventRecordItem[]> {
    const events = await this.prisma.activityEventRecord.findMany({
      orderBy: { cursor: 'desc' },
      take: Math.min(limit, 100),
    });

    return events.toReversed() as ActivityEventRecordItem[];
  }

  async getLatestCursor(): Promise<number> {
    const latest = await this.prisma.activityEventRecord.findFirst({
      orderBy: { cursor: 'desc' },
      select: { cursor: true },
    });

    return latest?.cursor ?? 0;
  }

  async getTotalCount(): Promise<number> {
    return this.prisma.activityEventRecord.count();
  }
}
