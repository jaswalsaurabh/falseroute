import {
  type SimulatedDeceptionCommand,
  type SimulatedDeceptionResult,
  SimulatedDeceptionCommandSchema,
  SimulatedDeceptionResultSchema,
} from '@false-route/contracts';

export const SIMULATED_AGENT_ADAPTER_VERSION = 'simulated-deception-agent-v1';

/**
 * Narrow interface for the in-process simulated deception agent.
 * Owned by the worker application layer.
 */
export interface SimulatedDeceptionAgent {
  recordCommand(command: SimulatedDeceptionCommand): Promise<SimulatedDeceptionResult>;
}

/**
 * Deterministic in-process adapter for simulated deception.
 * Validates bounded application commands at the boundary and returns allowlisted
 * simulation evidence without executing any real external side effects.
 */
export class DeterministicSimulatedDeceptionAdapter implements SimulatedDeceptionAgent {
  readonly version = SIMULATED_AGENT_ADAPTER_VERSION;

  async recordCommand(command: SimulatedDeceptionCommand): Promise<SimulatedDeceptionResult> {
    // 1. Strict boundary validation
    const validatedCommand = SimulatedDeceptionCommandSchema.parse(command);

    // 2. Explicit negative control verification
    if (validatedCommand.action !== 'ASSIGN_FALSE_ROUTE') {
      throw new Error(
        `SimulatedDeceptionAdapter rejected unauthorized action: "${validatedCommand.action}". Only ASSIGN_FALSE_ROUTE is permitted.`,
      );
    }

    if (validatedCommand.containmentMode !== 'SIMULATED') {
      throw new Error(
        `SimulatedDeceptionAdapter rejected non-simulated containment mode: "${validatedCommand.containmentMode}".`,
      );
    }

    if (validatedCommand.assignedFalseRoute !== 'mock-admin-decoy') {
      throw new Error(
        `SimulatedDeceptionAdapter rejected non-allowlisted destination: "${validatedCommand.assignedFalseRoute}".`,
      );
    }

    // 3. Return bounded, validated simulation recording evidence
    const result: SimulatedDeceptionResult = {
      status: 'RECORDED',
      recordedAt: new Date().toISOString(),
      adapterVersion: this.version,
      provenance: 'DERIVED',
    };

    return SimulatedDeceptionResultSchema.parse(result);
  }
}
