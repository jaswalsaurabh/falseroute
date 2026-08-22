import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@false-route/config';
import { parseWorkerConfig } from './worker-config.js';

const validWorkerEnv = {
  DATABASE_URL: 'postgresql://example:example@127.0.0.1:5432/example',
};

describe('worker configuration claim lease safety margin', () => {
  it('uses a configuration-owned margin that leaves the default lease time for persistence', () => {
    const config = parseWorkerConfig(validWorkerEnv);

    expect(config.WORKER_CLAIM_PERSISTENCE_MARGIN_MS).toBe(5000);
    expect(config.WORKER_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(
      config.GEMINI_OPERATION_DEADLINE_MS + config.WORKER_CLAIM_PERSISTENCE_MARGIN_MS,
    );
  });

  it('accepts a lease exactly equal to the Gemini deadline plus the persistence margin', () => {
    const config = parseWorkerConfig({
      ...validWorkerEnv,
      GEMINI_OPERATION_DEADLINE_MS: '8000',
      WORKER_CLAIM_PERSISTENCE_MARGIN_MS: '2000',
      WORKER_CLAIM_LEASE_MS: '10000',
    });

    expect(config.WORKER_CLAIM_LEASE_MS).toBe(10000);
  });

  it('rejects a lease one millisecond short of the required deadline and persistence margin', () => {
    expect(() =>
      parseWorkerConfig({
        ...validWorkerEnv,
        GEMINI_OPERATION_DEADLINE_MS: '8000',
        WORKER_CLAIM_PERSISTENCE_MARGIN_MS: '2000',
        WORKER_CLAIM_LEASE_MS: '9999',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects shutdown timeouts where sub-budgets exceed the total shutdown timeout', () => {
    expect(() =>
      parseWorkerConfig({
        ...validWorkerEnv,
        WORKER_SHUTDOWN_TIMEOUT_MS: '5000',
        WORKER_DRAIN_TIMEOUT_MS: '4000',
        WORKER_DB_DISCONNECT_TIMEOUT_MS: '2000',
        WORKER_TELEMETRY_TIMEOUT_MS: '1000',
      }),
    ).toThrow(ConfigurationError);
  });

  it('accepts shutdown timeouts where sub-budgets fit cleanly within total timeout', () => {
    const config = parseWorkerConfig({
      ...validWorkerEnv,
      WORKER_SHUTDOWN_TIMEOUT_MS: '8000',
      WORKER_DRAIN_TIMEOUT_MS: '5000',
      WORKER_DB_DISCONNECT_TIMEOUT_MS: '2000',
      WORKER_TELEMETRY_TIMEOUT_MS: '1000',
    });
    expect(config.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(8000);
    expect(config.WORKER_DRAIN_TIMEOUT_MS).toBe(5000);
  });
});
