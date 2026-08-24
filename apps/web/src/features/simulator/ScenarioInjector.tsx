import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  CreateAutonomousScenarioRequestSchema,
  SCENARIO_CATALOG,
  type IntrusionEvent,
  type ScenarioKind,
} from '@false-route/contracts';
import { type ApiClient } from '../../api/client.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
export interface ScenarioInjectorProps {
  readonly client: ApiClient;
  readonly events?: readonly IntrusionEvent[];
  readonly onSelectEvent?: (event: IntrusionEvent) => void;
  readonly onInjected?: () => void;
}
const statusVariant = (status: IntrusionEvent['status']) =>
  status === 'DECIDED'
    ? ('success' as const)
    : status === 'FAILED'
      ? ('danger' as const)
      : status === 'PENDING' || status === 'PROCESSING'
        ? ('warning' as const)
        : ('info' as const);

const relativeTime = (receivedAt: string): string => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(receivedAt)) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  return `${Math.floor(elapsedSeconds / 3600)}h ago`;
};

export const ScenarioInjector: React.FC<ScenarioInjectorProps> = ({
  client,
  events = [],
  onSelectEvent,
  onInjected,
}) => {
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
    <section
      className="pane pane-telemetry"
      id="scenario-injector"
      aria-labelledby="scenario-injector-heading"
    >
      <div className="pane-header">
        <div>
          <h2 id="scenario-injector-heading">
            <span className="pane-step">01</span>Telemetry
            <span className="sr-only">1. Autonomous Scenario Injector</span>
          </h2>
          <p>Incoming signals, normalized and queued</p>
        </div>
        <span className="status-chip status-chip-compact">
          <span className="status-dot status-dot-observed" /> Live
        </span>
      </div>
      <div className="telemetry-feed" aria-label="Recent intrusion signals">
        {events.length === 0 ? (
          <div className="telemetry-empty">
            No signals recorded. Select a fixed scenario below to begin the bounded workflow.
          </div>
        ) : (
          events.slice(0, 4).map((event) => (
            <button
              type="button"
              className="telemetry-event"
              key={event.id}
              onClick={() => onSelectEvent?.(event)}
              aria-label={`Inspect ${event.eventType.replaceAll('_', ' ').toLowerCase()} event`}
            >
              <span className="telemetry-event-heading">
                <strong>{event.eventType.replaceAll('_', ' ').toLowerCase()}</strong>
                <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
              </span>
              <span className="telemetry-event-meta">
                <code>{event.sourceIp}</code>
                <span>
                  {relativeTime(event.receivedAt)} · {event.id.slice(0, 8).toUpperCase()}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      <form className="scenario-footer" onSubmit={handleInject}>
        <span className="scenario-label">Preview a fixed synthetic scenario</span>
        <div className="scenario-grid" aria-label="Fixed scenario catalog">
          {Object.values(SCENARIO_CATALOG).map((item) => (
            <button
              key={item.kind}
              type="button"
              className="scenario-option"
              aria-pressed={selectedScenario === item.kind}
              onClick={() => {
                setSelectedScenario(item.kind);
                const sourceIp = item.defaultEvidence['sourceIp'];
                if (typeof sourceIp === 'string') setCustomIp(sourceIp);
                setFeedback(null);
              }}
            >
              <strong>{item.title}</strong>
              <span>
                Risk ceiling {item.maxRiskScore} · {item.decoyTemplate ? 'decoy' : 'quarantine'}
              </span>
            </button>
          ))}
        </div>
        <div className="scenario-submit-row">
          <label htmlFor="custom-ip-input">
            <span className="sr-only">Synthetic source IP</span>
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
            <Send size={15} /> Inject scenario
          </Button>
        </div>
        <p className="selected-scenario-copy">
          <strong>{preset.title}:</strong> {preset.description}
        </p>
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
