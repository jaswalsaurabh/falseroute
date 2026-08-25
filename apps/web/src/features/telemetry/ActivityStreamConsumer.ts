import {
  ActivityEventSchema,
  ActivitySnapshotResponseSchema,
  type ActivityEvent,
  type SystemMode,
} from '@false-route/contracts';

export interface ActivityStreamCallbacks {
  onEvent: (event: ActivityEvent) => void;
  onSystemMode?: (mode: SystemMode) => void;
  onStatusChange?: (status: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED') => void;
}

export class ActivityStreamConsumer {
  private abortController: AbortController | null = null;
  private lastEventId = 0;
  private isRunning = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 3000;

  constructor(
    private readonly token: string | null,
    private readonly baseUrl = '',
    private readonly callbacks: ActivityStreamCallbacks = { onEvent: () => {} },
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.connect();
  }

  stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.callbacks.onStatusChange?.('DISCONNECTED');
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    this.callbacks.onStatusChange?.(this.lastEventId > 0 ? 'RECONNECTING' : 'CONNECTING');
    this.abortController = new AbortController();

    try {
      await this.repairFromSnapshot(this.abortController.signal);
      if (!this.isRunning) return;

      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (this.lastEventId > 0) headers['Last-Event-ID'] = String(this.lastEventId);

      const response = await fetch(`${this.baseUrl}/api/v1/activity/stream`, {
        headers,
        credentials: 'include',
        signal: this.abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE stream connection failed: HTTP ${response.status}`);
      }

      this.callbacks.onStatusChange?.('CONNECTED');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.isRunning) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const retryMs = this.parseSseBlock(block.trim());
          if (retryMs !== undefined) {
            this.reconnectDelayMs = Math.min(Math.max(retryMs, 250), 10000);
            throw new Error('SSE catch-up failed; reconnect requested by server');
          }
        }
      }
    } catch (error) {
      if (!this.isRunning) return;
      console.warn('[ActivityStreamConsumer] Stream interrupted, scheduling reconnect:', error);
    }

    if (this.isRunning) {
      this.callbacks.onStatusChange?.('RECONNECTING');
      this.reconnectTimeout = setTimeout(() => void this.connect(), this.reconnectDelayMs);
    }
  }

  private async repairFromSnapshot(signal: AbortSignal): Promise<void> {
    const initialCursor = this.lastEventId;
    const firstUrl =
      initialCursor > 0
        ? `${this.baseUrl}/api/v1/activity?sinceCursor=${initialCursor}&limit=100`
        : `${this.baseUrl}/api/v1/activity?limit=100`;
    let response = await this.fetchSnapshot(firstUrl, signal);
    const repairThrough = response.latestCursor;
    this.deliverSnapshot(response.events);
    this.callbacks.onSystemMode?.(response.systemMode);

    // Initial snapshots contain the newest window and therefore already end at
    // latestCursor. Reconnection repair paginates forward to the captured cursor.
    if (initialCursor === 0) {
      this.lastEventId = Math.max(this.lastEventId, repairThrough);
      return;
    }

    while (this.lastEventId < repairThrough) {
      const beforePage = this.lastEventId;
      // Cursor pagination is intentionally sequential; each request starts after the prior page.
      // eslint-disable-next-line no-await-in-loop
      response = await this.fetchSnapshot(
        `${this.baseUrl}/api/v1/activity?sinceCursor=${this.lastEventId}&limit=100`,
        signal,
      );
      this.deliverSnapshot(response.events);
      if (this.lastEventId === beforePage) {
        // A PostgreSQL sequence can contain gaps; no persisted event was omitted.
        this.lastEventId = repairThrough;
      }
    }
  }

  private async fetchSnapshot(url: string, signal: AbortSignal) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(url, {
      headers,
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error(`Activity snapshot failed: HTTP ${response.status}`);
    return ActivitySnapshotResponseSchema.parse(await response.json());
  }

  private deliverSnapshot(events: readonly ActivityEvent[]): void {
    for (const event of events) {
      if (event.cursor <= this.lastEventId) continue;
      this.lastEventId = event.cursor;
      this.callbacks.onEvent(event);
    }
  }

  private parseSseBlock(block: string): number | undefined {
    if (!block) return undefined;

    let eventType = 'activity';
    let data = '';
    let id: number | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        const parsedId = parseInt(line.slice(3).trim(), 10);
        if (!Number.isNaN(parsedId)) id = parsedId;
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      }
    }

    if (eventType === 'stream_error') {
      try {
        const parsed = JSON.parse(data) as { retryMs?: unknown };
        return typeof parsed.retryMs === 'number' ? parsed.retryMs : 1000;
      } catch {
        return 1000;
      }
    }

    if (eventType === 'system_mode') {
      try {
        const parsed = JSON.parse(data) as { mode?: SystemMode };
        if (parsed.mode) this.callbacks.onSystemMode?.(parsed.mode);
      } catch {
        // An invalid informational event does not advance the durable cursor.
      }
      return undefined;
    }

    if (eventType === 'activity' && data) {
      try {
        const parsed = ActivityEventSchema.safeParse(JSON.parse(data));
        if (
          parsed.success &&
          (id === undefined || id === parsed.data.cursor) &&
          parsed.data.cursor > this.lastEventId
        ) {
          this.lastEventId = parsed.data.cursor;
          this.callbacks.onEvent(parsed.data);
        }
      } catch {
        // Invalid provider data cannot advance the durable resume cursor.
      }
    }
    return undefined;
  }
}
