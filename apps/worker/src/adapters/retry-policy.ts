export interface RetryPolicyOptions {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoffMultiplier?: number;
  readonly randomFn?: () => number;
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RetryPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
  readonly randomFn: () => number;
  readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.initialDelayMs = options.initialDelayMs ?? 200;
    this.maxDelayMs = options.maxDelayMs ?? 1000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.randomFn = options.randomFn ?? Math.random;
    this.sleepFn =
      options.sleepFn ??
      ((ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('Sleep aborted'));
            return;
          }
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason ?? new Error('Sleep aborted'));
            },
            { once: true },
          );
        }));
  }

  calculateDelay(attempt: number): number {
    const baseDelay = Math.min(
      this.maxDelayMs,
      this.initialDelayMs * Math.pow(this.backoffMultiplier, attempt),
    );
    const jitterFactor = 1 + this.randomFn() * 0.2;
    return Math.round(baseDelay * jitterFactor);
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleepFn(ms, signal);
  }
}
