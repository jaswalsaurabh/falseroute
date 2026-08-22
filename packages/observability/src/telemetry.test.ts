import { describe, expect, it } from 'vitest';
import { createTelemetry } from './telemetry.js';

describe('createTelemetry', () => {
  it('returns a safe no-op handle when disabled', async () => {
    const handle = createTelemetry({
      serviceName: 'test-api',
      environment: 'test',
      enabled: false,
    });

    expect(handle.isEnabled).toBe(false);
    expect(handle.tracer).toBeDefined();

    // Init and shutdown should resolve gracefully without throwing or starting exporters
    await expect(handle.init()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('creates an initialized handle when enabled without throwing on shutdown', async () => {
    const handle = createTelemetry({
      serviceName: 'test-worker',
      environment: 'test',
      enabled: true,
    });

    expect(handle.isEnabled).toBe(true);
    expect(handle.tracer).toBeDefined();

    await expect(handle.init()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
