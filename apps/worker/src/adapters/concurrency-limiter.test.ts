import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter, ConcurrencySaturationError } from './concurrency-limiter.js';

describe('ConcurrencyLimiter', () => {
  it('allows execution within concurrency limit', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2, maxQueueSize: 0 });

    const result = await limiter.execute(async () => {
      expect(limiter.activeCount).toBe(1);
      return 'success';
    });

    expect(result).toBe('success');
    expect(limiter.activeCount).toBe(0);
  });

  it('rejects immediately when saturated with zero queue size', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueueSize: 0 });

    let releaseFirst: () => void;
    const firstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Start first task holding the single slot
    const task1 = limiter.execute(async () => {
      await firstPromise;
      return 'task1';
    });

    expect(limiter.activeCount).toBe(1);

    // Second task attempts while saturated
    await expect(limiter.execute(async () => 'task2')).rejects.toThrow(ConcurrencySaturationError);

    // Complete first task
    releaseFirst!();
    await task1;

    expect(limiter.activeCount).toBe(0);
  });

  it('queues tasks up to maxQueueSize and executes FIFO', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueueSize: 2 });
    const order: number[] = [];

    let releaseSlot: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });

    const task1 = limiter.execute(async () => {
      order.push(1);
      await blocker;
    });

    const task2 = limiter.execute(async () => {
      order.push(2);
    });

    const task3 = limiter.execute(async () => {
      order.push(3);
    });

    expect(limiter.activeCount).toBe(1);
    expect(limiter.queuedCount).toBe(2);

    // 4th task exceeds queue size
    await expect(
      limiter.execute(async () => {
        order.push(4);
      }),
    ).rejects.toThrow(ConcurrencySaturationError);

    releaseSlot!();
    await Promise.all([task1, task2, task3]);

    expect(order).toEqual([1, 2, 3]);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  it('cleans up queue when parent signal aborts while waiting in queue', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueueSize: 2 });
    const abortController = new AbortController();

    let releaseSlot: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });

    const task1 = limiter.execute(async () => {
      await blocker;
    });

    const task2 = limiter.execute(async () => 'task2', abortController.signal);
    expect(limiter.queuedCount).toBe(1);

    abortController.abort(new Error('Caller cancelled'));

    await expect(task2).rejects.toThrow('Caller cancelled');
    expect(limiter.queuedCount).toBe(0);

    releaseSlot!();
    await task1;
    expect(limiter.activeCount).toBe(0);
  });

  it('always releases permit when task throws an error', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueueSize: 0 });

    await expect(
      limiter.execute(async () => {
        throw new Error('Task internal crash');
      }),
    ).rejects.toThrow('Task internal crash');

    expect(limiter.activeCount).toBe(0);
  });
});
