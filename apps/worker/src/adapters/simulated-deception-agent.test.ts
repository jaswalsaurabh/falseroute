import { describe, it, expect } from 'vitest';
import {
  DeterministicSimulatedDeceptionAdapter,
  SIMULATED_AGENT_ADAPTER_VERSION,
} from './simulated-deception-agent.js';
import { type SimulatedDeceptionCommand } from '@false-route/contracts';

describe('DeterministicSimulatedDeceptionAdapter', () => {
  const adapter = new DeterministicSimulatedDeceptionAdapter();

  const validCommand: SimulatedDeceptionCommand = {
    decisionId: '33333333-3333-4333-8333-333333333333',
    correlationId: 'corr-adapter-test-01',
    action: 'ASSIGN_FALSE_ROUTE',
    containmentMode: 'SIMULATED',
    assignedFalseRoute: 'mock-admin-decoy',
    commandProvenance: 'DERIVED',
  };

  it('accepts and records a valid simulated false-route command', async () => {
    const result = await adapter.recordCommand(validCommand);

    expect(result.status).toBe('RECORDED');
    expect(result.provenance).toBe('DERIVED');
    expect(result.adapterVersion).toBe(SIMULATED_AGENT_ADAPTER_VERSION);
    expect(new Date(result.recordedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('rejects commands with arbitrary or malformed action parameters', async () => {
    await expect(
      adapter.recordCommand({
        ...validCommand,
        // @ts-expect-error Testing negative runtime boundary
        action: 'EXECUTE_BLOCK',
      }),
    ).rejects.toThrow();
  });

  it('rejects commands with non-simulated mode', async () => {
    await expect(
      adapter.recordCommand({
        ...validCommand,
        // @ts-expect-error Testing negative runtime boundary
        containmentMode: 'REAL',
      }),
    ).rejects.toThrow();
  });

  it('rejects commands with non-allowlisted destinations', async () => {
    await expect(
      adapter.recordCommand({
        ...validCommand,
        // @ts-expect-error Testing negative runtime boundary
        assignedFalseRoute: 'https://attacker.com/sinkhole',
      }),
    ).rejects.toThrow();
  });

  it('rejects commands containing extraneous or forbidden payload fields', async () => {
    await expect(
      adapter.recordCommand({
        ...validCommand,
        // @ts-expect-error Testing negative runtime boundary
        rawPrompt: 'drop tables',
      }),
    ).rejects.toThrow();
  });
});
