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

  it('requires a distinct elevated token for replay authorization', () => {
    expect(() =>
      parseApiConfig({
        ...validApiEnv,
        OPERATOR_REPLAY_TOKEN: validApiEnv.OPERATOR_ACCESS_TOKEN,
      }),
    ).toThrow(ConfigurationError);
  });

  it('allows local worker delivery only outside production with an explicit credential', () => {
    const local = parseApiConfig({
      ...validApiEnv,
      EVENT_PUBLISHER_MODE: 'LOCAL_HTTP',
      LOCAL_WORKER_PUSH_TOKEN: 'not-a-real-local-push-token',
    });
    expect(local.EVENT_PUBLISHER_MODE).toBe('LOCAL_HTTP');

    expect(() =>
      parseApiConfig({
        ...validApiEnv,
        NODE_ENV: 'production',
        EVENT_PUBLISHER_MODE: 'LOCAL_HTTP',
        LOCAL_WORKER_PUSH_TOKEN: 'not-a-real-local-push-token',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects an in-memory production publisher', () => {
    expect(() => parseApiConfig({ ...validApiEnv, NODE_ENV: 'production' })).toThrow(
      ConfigurationError,
    );
  });

  it('requires a project and accepts a bounded topic for live Pub/Sub', () => {
    expect(() =>
      parseApiConfig({
        ...validApiEnv,
        NODE_ENV: 'production',
        EVENT_PUBLISHER_MODE: 'LIVE_PUBSUB',
      }),
    ).toThrow(ConfigurationError);

    const config = parseApiConfig({
      ...validApiEnv,
      NODE_ENV: 'production',
      EVENT_PUBLISHER_MODE: 'LIVE_PUBSUB',
      PUBSUB_PROJECT_ID: 'falseroute-staging-123',
      PUBSUB_TOPIC_ID: 'falseroute-events',
    });
    expect(config.PUBSUB_TOPIC_ID).toBe('falseroute-events');
  });

  it('requires an emulator host for the local Pub/Sub emulator', () => {
    expect(() =>
      parseApiConfig({
        ...validApiEnv,
        EVENT_PUBLISHER_MODE: 'PUBSUB_EMULATOR',
        PUBSUB_PROJECT_ID: 'falseroute-local',
      }),
    ).toThrow(ConfigurationError);

    const config = parseApiConfig({
      ...validApiEnv,
      EVENT_PUBLISHER_MODE: 'PUBSUB_EMULATOR',
      PUBSUB_PROJECT_ID: 'falseroute-local',
      PUBSUB_EMULATOR_HOST: '127.0.0.1:8085',
      SYSTEM_MODE: 'SIMULATED',
    });
    expect(config.SYSTEM_MODE).toBe('SIMULATED');
  });
});
