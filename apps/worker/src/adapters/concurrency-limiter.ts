export class ConcurrencySaturationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencySaturationError';
  }
}

export interface ConcurrencyLimiterOptions {
  readonly maxConcurrency: number;
  readonly maxQueueSize?: number;
}

interface QueuedItem {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly abortCleanup: () => void;
}

/**
 * Process-local bounded concurrency limiter with zero or finite queue capacity.
 * Guarantees that saturation does not create an unbounded queue.
 * Guarantees permit release across successful completion, errors, timeouts, and cancellations.
 */
export class ConcurrencyLimiter {
  readonly maxConcurrency: number;
  readonly maxQueueSize: number;

  private currentActive = 0;
  private readonly queue: QueuedItem[] = [];

  constructor(options: ConcurrencyLimiterOptions) {
    if (options.maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be at least 1, received ${options.maxConcurrency}`);
    }
    this.maxConcurrency = options.maxConcurrency;
    this.maxQueueSize = options.maxQueueSize ?? 0;
  }

  get activeCount(): number {
    return this.currentActive;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async execute<T>(
    task: (signal?: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    if (parentSignal?.aborted) {
      throw (
        parentSignal.reason ?? new Error('Operation aborted prior to acquiring concurrency slot')
      );
    }

    await this.acquire(parentSignal);

    try {
      return await task(parentSignal);
    } finally {
      this.release();
    }
  }

  private async acquire(parentSignal?: AbortSignal): Promise<void> {
    if (this.currentActive < this.maxConcurrency) {
      this.currentActive++;
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new ConcurrencySaturationError(
        `Provider concurrency limit saturated (active: ${this.currentActive}/${this.maxConcurrency}, queued: ${this.queue.length}/${this.maxQueueSize})`,
      );
    }

    return new Promise<void>((resolve, reject) => {
      let item: QueuedItem;

      const onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(
          parentSignal?.reason ?? new Error('Operation aborted while waiting in concurrency queue'),
        );
      };

      const abortCleanup = () => {
        if (parentSignal) {
          parentSignal.removeEventListener('abort', onAbort);
        }
      };

      if (parentSignal) {
        parentSignal.addEventListener('abort', onAbort, { once: true });
      }

      item = {
        resolve: () => {
          abortCleanup();
          this.currentActive++;
          resolve();
        },
        reject: (err) => {
          abortCleanup();
          reject(err);
        },
        abortCleanup,
      };

      this.queue.push(item);
    });
  }

  private release(): void {
    this.currentActive--;

    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next.resolve();
        return;
      }
    }
  }
}
