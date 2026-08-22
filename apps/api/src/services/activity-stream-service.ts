import type { Response } from 'express';
import type { ActivityEvent } from '@false-route/contracts';
import { type ActivityEventRepository } from '@false-route/database';
import {
  deepRedactSensitiveData,
  sanitizeActivityEvent,
  toSafeActivityEvent,
} from './activity-event-projection.js';

export interface ActivityStreamServiceOptions {
  readonly maxConnections?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxClientBufferBytes?: number;
  readonly pollIntervalMs?: number;
  readonly pageSize?: number;
}

export interface ActivitySnapshot {
  readonly events: readonly ActivityEvent[];
  readonly latestCursor: number;
  readonly totalCount: number;
  readonly systemMode: 'LOCAL_FAKE';
}

interface StreamClient {
  readonly response: Response;
  cursor: number;
  catchingUp: boolean;
  readonly pending: ActivityEvent[];
}

/**
 * Database-backed single-instance SSE fanout. The database remains the source of
 * truth, so activity persisted by another process is observed by the API poller.
 * Deployment-wide connection accounting and notification fanout are deliberately
 * deferred until the service is horizontally scaled.
 */
export class ActivityStreamService {
  private readonly clients = new Map<Response, StreamClient>();
  private readonly maxConnections: number;
  private readonly maxClientBufferBytes: number;
  private readonly pageSize: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private observedCursor = 0;

  constructor(
    private readonly activityRepo?: ActivityEventRepository,
    options: ActivityStreamServiceOptions = {},
  ) {
    this.maxConnections = options.maxConnections ?? 50;
    this.maxClientBufferBytes = options.maxClientBufferBytes ?? 65536;
    this.pageSize = Math.min(options.pageSize ?? 100, 100);
    this.startHeartbeat(options.heartbeatIntervalMs ?? 15000);
    if (activityRepo) this.startPolling(options.pollIntervalMs ?? 1000);
  }

  async getSnapshot(afterCursor?: number, limit = 50): Promise<ActivitySnapshot> {
    if (!this.activityRepo) {
      return {
        events: [],
        latestCursor: 0,
        totalCount: 0,
        systemMode: 'LOCAL_FAKE',
      };
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const latestCursor = await this.activityRepo.getLatestCursor();
    const records =
      afterCursor === undefined
        ? await this.activityRepo.getLatestEvents(safeLimit)
        : await this.activityRepo.getEventsBetween(afterCursor, latestCursor, safeLimit);
    const totalCount = await this.activityRepo.getTotalCount();
    return {
      events: records.map((record) => toSafeActivityEvent(record)),
      latestCursor,
      totalCount,
      systemMode: 'LOCAL_FAKE',
    };
  }

  async registerClient(res: Response, lastEventId = 0): Promise<boolean> {
    if (this.clients.size >= this.maxConnections) {
      res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        message: 'Maximum concurrent SSE stream connections reached. Please retry later.',
      });
      return false;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client: StreamClient = {
      response: res,
      cursor: Math.max(lastEventId, 0),
      catchingUp: true,
      pending: [],
    };
    this.clients.set(res, client);
    res.on('close', () => this.clients.delete(res));

    if (
      !this.safeWrite(
        client,
        this.formatNamedEvent('system_mode', {
          mode: 'LOCAL_FAKE',
          connectedAt: new Date().toISOString(),
        }),
      )
    ) {
      return false;
    }

    try {
      if (this.activityRepo) {
        const catchUpThrough = await this.activityRepo.getLatestCursor();
        while (client.cursor < catchUpThrough && this.clients.has(res)) {
          // The finite upper bound prevents a busy stream from starving registration.
          // eslint-disable-next-line no-await-in-loop
          const page = await this.activityRepo.getEventsBetween(
            client.cursor,
            catchUpThrough,
            this.pageSize,
          );
          if (page.length === 0) break;
          for (const record of page) {
            if (!this.sendActivity(client, toSafeActivityEvent(record))) return false;
          }
        }
      }

      client.pending.sort((left, right) => left.cursor - right.cursor);
      for (const event of client.pending) {
        if (!this.sendActivity(client, event)) return false;
      }
      client.pending.length = 0;
      client.catchingUp = false;
      return this.clients.has(res);
    } catch {
      this.safeWrite(
        client,
        this.formatNamedEvent('stream_error', { error: 'CATCH_UP_FAILED', retryMs: 1000 }),
      );
      this.disconnect(client);
      return false;
    }
  }

  broadcast(event: ActivityEvent): void {
    const safeEvent = sanitizeActivityEvent(event);
    for (const client of this.clients.values()) {
      if (safeEvent.cursor <= client.cursor) continue;
      if (client.catchingUp) {
        if (!client.pending.some((pending) => pending.cursor === safeEvent.cursor)) {
          client.pending.push(safeEvent);
        }
        continue;
      }
      this.sendActivity(client, safeEvent);
    }
  }

  getActiveClientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
    for (const client of this.clients.values()) this.disconnect(client);
  }

  public deepRedactSensitiveData(data: unknown): unknown {
    return deepRedactSensitiveData(data);
  }

  private startPolling(intervalMs: number): void {
    this.pollTimer = setInterval(() => void this.pollPersistedEvents(), intervalMs);
    this.pollTimer.unref?.();
  }

  private async pollPersistedEvents(): Promise<void> {
    if (!this.activityRepo || this.pollInFlight || this.clients.size === 0) return;
    this.pollInFlight = true;
    try {
      const throughCursor = await this.activityRepo.getLatestCursor();
      while (this.observedCursor < throughCursor) {
        // eslint-disable-next-line no-await-in-loop
        const page = await this.activityRepo.getEventsBetween(
          this.observedCursor,
          throughCursor,
          this.pageSize,
        );
        if (page.length === 0) break;
        for (const record of page) {
          this.observedCursor = Math.max(this.observedCursor, record.cursor);
          this.broadcast(toSafeActivityEvent(record));
        }
      }
    } catch {
      for (const client of this.clients.values()) {
        this.safeWrite(
          client,
          this.formatNamedEvent('stream_error', {
            error: 'ACTIVITY_SOURCE_UNAVAILABLE',
            retryMs: 1000,
          }),
        );
        this.disconnect(client);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      const ping = this.formatNamedEvent('heartbeat', { timestamp: new Date().toISOString() });
      for (const client of this.clients.values()) this.safeWrite(client, ping);
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private sendActivity(client: StreamClient, event: ActivityEvent): boolean {
    if (event.cursor <= client.cursor) return true;
    if (!this.safeWrite(client, this.formatSseMessage(event))) return false;
    client.cursor = event.cursor;
    return true;
  }

  private safeWrite(client: StreamClient, payload: string): boolean {
    const res = client.response;
    if (
      res.destroyed ||
      res.writableEnded ||
      res.writableLength + Buffer.byteLength(payload) > this.maxClientBufferBytes
    ) {
      this.disconnect(client);
      return false;
    }
    try {
      if (!res.write(payload)) {
        this.disconnect(client);
        return false;
      }
      return true;
    } catch {
      this.disconnect(client);
      return false;
    }
  }

  private disconnect(client: StreamClient): void {
    this.clients.delete(client.response);
    if (!client.response.writableEnded) {
      try {
        client.response.end();
      } catch {
        // The socket is already unusable.
      }
    }
  }

  private formatSseMessage(event: ActivityEvent): string {
    return `id: ${event.cursor}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private formatNamedEvent(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
