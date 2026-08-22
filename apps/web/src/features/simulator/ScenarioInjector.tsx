import React, { useState } from 'react';
import { Crosshair, Send, Server, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  CreateAutonomousScenarioRequestSchema,
  SCENARIO_CATALOG,
  type ScenarioKind,
} from '@false-route/contracts';
import { type ApiClient } from '../../api/client.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { IconBadge } from '../../components/IconBadge.js';
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
  const preset = SCENARIO_CATALOG[selectedScenario];
  const handleInject = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);
    try {
      const payload = CreateAutonomousScenarioRequestSchema.parse({
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        correlationId: `corr-scenario-${Date.now().toString(36)}`,
        scenarioKind: selectedScenario,
        sourceIp: customIp,
        evidence: { ...preset.defaultEvidence, sourceIp: customIp },
      });
      const result = await client.createAutonomousScenario(payload);
      const message = `Scenario '${preset.title}': ${result.message}.`;
      setFeedback({ type: 'success', message });
      toast.success('Telemetry dispatched', { description: message });
      onInjected?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to dispatch scenario event';
      setFeedback({ type: 'error', message });
      toast.error('Telemetry dispatch failed', { description: message });
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <section className="pane pane-telemetry" aria-labelledby="scenario-injector-heading">
      <div className="pane-header">
        <div className="pane-title">
          <IconBadge tone="observed">
            <Crosshair size={17} />
          </IconBadge>
          <div>
            <h2 id="scenario-injector-heading">
              Telemetry <span className="sr-only">1. Autonomous Scenario Injector</span>
            </h2>
            <p>Incoming signals, normalized and queued</p>
          </div>
        </div>
        <Badge variant="success">Live</Badge>
      </div>
      <form className="injector-form" onSubmit={handleInject}>
        <div className="section-kicker">
          <ShieldAlert size={15} /> Fixed synthetic scenario
        </div>
        <label htmlFor="scenario-select">
          Attack Scenario Pattern
          <select
            id="scenario-select"
            className="input-field"
            value={selectedScenario}
            onChange={(event) => {
              setSelectedScenario(event.target.value as ScenarioKind);
              setFeedback(null);
            }}
          >
            {Object.values(SCENARIO_CATALOG).map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="scenario-preview">
          <strong>{preset.description}</strong>
          <span>
            <Server size={14} /> policy: <code>{preset.expectedPolicy}</code>
          </span>
          <span>decoy: {preset.decoyTemplate ?? 'quarantine response'}</span>
        </div>
        <label htmlFor="custom-ip-input">
          Synthetic source IP
          <input
            id="custom-ip-input"
            type="text"
            className="input-field mono"
            value={customIp}
            onChange={(event) => setCustomIp(event.target.value)}
            pattern="^(\d{1,3}\.){3}\d{1,3}|([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$"
            required
          />
        </label>
        <Button type="submit" aria-label="Inject Attack Scenario" isLoading={isSubmitting}>
          <Send size={15} /> {isSubmitting ? 'Injecting telemetry' : 'Inject attack scenario'}
        </Button>
        {feedback && (
          <div role="status" className={`feedback feedback-${feedback.type}`}>
            <Badge variant={feedback.type === 'success' ? 'success' : 'danger'}>
              {feedback.type}
            </Badge>
            <span>{feedback.message}</span>
          </div>
        )}
      </form>
    </section>
  );
};
