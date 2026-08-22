import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@false-route/config';
import { parseApiConfig } from './api-config.js';

const validApiEnv = {
  DATABASE_URL: 'postgresql://example:example@127.0.0.1:5432/example',
  OPERATOR_ACCESS_TOKEN: 'not-a-real-test-token-123456',
};

describe('API Configuration Shutdown Budget Validation', () => {
  it('uses default partitioned shutdown budgets', () => {
    const config = parseApiConfig(validApiEnv);

    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(8000);
    expect(config.SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(5000);
    expect(config.SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS).toBe(2000);
    expect(config.SHUTDOWN_TELEMETRY_TIMEOUT_MS).toBe(1000);
  });

  it('accepts custom shutdown budgets where sub-budgets fit within total timeout', () => {
    const config = parseApiConfig({
      ...validApiEnv,
      SHUTDOWN_TIMEOUT_MS: '6000',
      SHUTDOWN_DRAIN_TIMEOUT_MS: '3000',
      SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '2000',
      SHUTDOWN_TELEMETRY_TIMEOUT_MS: '1000',
    });

    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(6000);
    expect(config.SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(3000);
  });

  it('rejects configuration where sub-budgets exceed total shutdown timeout', () => {
    expect(() =>
      parseApiConfig({
        ...validApiEnv,
        SHUTDOWN_TIMEOUT_MS: '4000',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '3000',
        SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: '2000',
        SHUTDOWN_TELEMETRY_TIMEOUT_MS: '1000',
      }),
    ).toThrow(ConfigurationError);
  });
});
