import { type Logger } from '@false-route/observability';
import { type EventProcessor, type ProcessResult } from './event-processor.js';

export interface OrchestratorOptions {
  readonly processor: EventProcessor;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
}

/**
 * Manages the background worker polling loop, single tick execution, and graceful shutdown.
 */
export class WorkerOrchestrator {
  private readonly processor: EventProcessor;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private isRunning = false;
  private activeLoop: Promise<void> | null = null;

  constructor(options: OrchestratorOptions) {
    this.processor = options.processor;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  /**
   * Executes a single processing tick (claims and evaluates one event if available).
   */
  async tick(): Promise<ProcessResult> {
    return this.processor.processNextPending();
  }

  /**
   * Starts continuous polling in the background.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Worker orchestrator started');

    const scheduleNext = (delayMs: number) => {
      if (!this.isRunning) return;
      this.timerHandle = setTimeout(() => {
        void this.runStep(scheduleNext);
      }, delayMs);
    };

    scheduleNext(0);
  }

  private timerHandle: NodeJS.Timeout | null = null;
  private currentStepPromise: Promise<void> | null = null;

  private async runStep(scheduleNext: (delayMs: number) => void): Promise<void> {
    if (!this.isRunning) return;
    const stepPromise = (async () => {
      try {
        const result = await this.processor.processNextPending();
        const nextDelay = result.processed ? 50 : this.pollIntervalMs;
        scheduleNext(nextDelay);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown loop error';
        this.logger.error({ error: errorMsg }, 'Error in worker loop; backing off');
        scheduleNext(this.pollIntervalMs * 2);
      }
    })();

    this.currentStepPromise = stepPromise;
    await stepPromise;
    this.currentStepPromise = null;
  }

  /**
   * Gracefully requests the polling loop to stop.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.info('Stopping worker orchestrator gracefully');
    this.isRunning = false;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.currentStepPromise) {
      await this.currentStepPromise;
      this.currentStepPromise = null;
    }
    this.logger.info('Worker orchestrator stopped');
  }
}
