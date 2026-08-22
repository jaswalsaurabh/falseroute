import React, { useState } from 'react';
import {
  CreateAutonomousScenarioRequestSchema,
  SCENARIO_CATALOG,
  type ScenarioKind,
} from '@false-route/contracts';
import { type ApiClient } from '../../api/client.js';

export interface ScenarioInjectorProps {
  readonly client: ApiClient;
  readonly onInjected?: () => void;
}

export const ScenarioInjector: React.FC<ScenarioInjectorProps> = ({ client, onInjected }) => {
  const [selectedScenario, setSelectedScenario] = useState<ScenarioKind>('ENV_FILE_PROBE');
  const [customIp, setCustomIp] = useState('198.51.100.25');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const scenarioPreset = SCENARIO_CATALOG[selectedScenario];

  const handleScenarioChange = (scenario: ScenarioKind) => {
    setSelectedScenario(scenario);
    setFeedback(null);
  };

  const handleInject = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);

    try {
      const eventId = crypto.randomUUID();
      const payload = CreateAutonomousScenarioRequestSchema.parse({
        id: eventId,
        occurredAt: new Date().toISOString(),
        correlationId: `corr-scenario-${Date.now().toString(36)}`,
        scenarioKind: selectedScenario,
        sourceIp: customIp,
        evidence: {
          ...scenarioPreset.defaultEvidence,
          sourceIp: customIp,
        },
      });

      const result = await client.createAutonomousScenario(payload);
      setFeedback({
        type: 'success',
        message: `Scenario '${scenarioPreset.title}': ${result.message}.`,
      });
      onInjected?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to dispatch scenario event',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="card" aria-labelledby="scenario-injector-heading">
      <h2
        id="scenario-injector-heading"
        style={{ fontSize: 'var(--text-size-lg)', marginBottom: 'var(--space-unit-md)' }}
      >
        1. Autonomous Scenario Injector
      </h2>

      <form
        onSubmit={handleInject}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-md)' }}
      >
        <div>
          <label
            htmlFor="scenario-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: 'var(--space-unit-xs)',
              fontSize: 'var(--text-size-sm)',
            }}
          >
            Attack Scenario Pattern
          </label>
          <select
            id="scenario-select"
            className="input-field"
            value={selectedScenario}
            onChange={(e) => handleScenarioChange(e.target.value as ScenarioKind)}
          >
            {Object.values(SCENARIO_CATALOG).map((preset) => (
              <option key={preset.kind} value={preset.kind}>
                {preset.title}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            padding: 'var(--space-unit-md)',
            backgroundColor: 'var(--surface-input)',
            borderRadius: 'var(--radius-card)',
            fontSize: 'var(--text-size-xs)',
          }}
        >
          <p style={{ marginBottom: 'var(--space-unit-xs)' }}>
            <strong>Description:</strong> {scenarioPreset.description}
          </p>
          <p style={{ marginBottom: 'var(--space-unit-xs)' }}>
            <strong>Expected Policy:</strong> <code>{scenarioPreset.expectedPolicy}</code>
          </p>
          <p style={{ marginBottom: 'var(--space-unit-xs)' }}>
            <strong>Decoy Template:</strong>{' '}
            {scenarioPreset.decoyTemplate ?? 'None (Quarantine response)'}
          </p>
          <p>
            <strong>Allowed Actions:</strong> {scenarioPreset.allowedActions.join(', ')}
          </p>
        </div>

        <div>
          <label
            htmlFor="custom-ip-input"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: 'var(--space-unit-xs)',
              fontSize: 'var(--text-size-sm)',
            }}
          >
            Synthetic Source IP Address
          </label>
          <input
            id="custom-ip-input"
            type="text"
            className="input-field"
            value={customIp}
            onChange={(e) => setCustomIp(e.target.value)}
            pattern="^(\d{1,3}\.){3}\d{1,3}|([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$"
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSubmitting}
          style={{ alignSelf: 'flex-start' }}
        >
          {isSubmitting ? 'Injecting Telemetry...' : 'Inject Attack Scenario'}
        </button>

        {feedback && (
          <div
            role="status"
            className={`badge ${feedback.type === 'success' ? 'badge-success' : 'badge-danger'}`}
            style={{ padding: 'var(--space-unit-sm)' }}
          >
            {feedback.message}
          </div>
        )}
      </form>
    </section>
  );
};
