import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '@false-route/observability';
import { WorkerOrchestrator } from './worker-orchestrator.js';
import { type EventProcessor } from './event-processor.js';

function createCapturingLogger() {
  const rawLines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      rawLines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({
    serviceName: 'capturing-test-worker-orchestrator',
    level: 'trace',
    destination: stream,
  });
  return { logger, rawLines };
}

describe('WorkerOrchestrator', () => {
  it('runs the campaign continuation sweep after a processing tick', async () => {
    const processNextPending = vi.fn().mockResolvedValue({ processed: false });
    const resumeCampaigns = vi.fn().mockResolvedValue(undefined);
    const orchestrator = new WorkerOrchestrator({
      processor: { processNextPending } as unknown as EventProcessor,
      logger: createCapturingLogger().logger,
      resumeCampaigns,
    });

    await orchestrator.tick();

    expect(processNextPending).toHaveBeenCalledOnce();
    expect(resumeCampaigns).toHaveBeenCalledOnce();
  });

  it('logs only safe error type and category when a processing step rejects', async () => {
    vi.useFakeTimers();
    const { logger, rawLines } = createCapturingLogger();
    const databaseCredential = 'not-a-real-database-password';
    const bearerToken = 'dummy-not-a-real-bearer-token';
    const rawError = new Error(
      `orchestrator failure\n` +
        `url=postgresql://dummy-user:${databaseCredential}@database.example.test/falseroute\n` +
        `Authorization: Bearer ${bearerToken}\n` +
        `payload=${'RAW_PROVIDER_PAYLOAD_'.repeat(80)}`,
    );
    const processNextPending = vi.fn(async () => {
      throw rawError;
    });
    const processor = { processNextPending } as unknown as EventProcessor;
    const orchestrator = new WorkerOrchestrator({
      processor,
      logger,
      pollIntervalMs: 500,
    });

    try {
      orchestrator.start();
      await vi.advanceTimersByTimeAsync(0);
      await orchestrator.stop();

      const logs = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const failureLog = logs.find((line) => line.msg === 'Error in worker loop; backing off');
      expect(failureLog).toMatchObject({
        loopFailure: 'UNCAUGHT_STEP_ERROR',
        errorType: 'Error',
      });
      const combinedLogs = rawLines.join('\n');
      expect(combinedLogs).not.toContain(databaseCredential);
      expect(combinedLogs).not.toContain(bearerToken);
      expect(combinedLogs).not.toContain('RAW_PROVIDER_PAYLOAD_');
      expect(combinedLogs).not.toContain(rawError.message);
    } finally {
      vi.useRealTimers();
    }
  });
});
