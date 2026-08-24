import React, { useState } from 'react';
import { Activity, CheckCircle2, Radio, Send, TriangleAlert } from 'lucide-react';
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
import { IconBadge } from '../../components/IconBadge.js';
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
  const awaitingDecision = events.filter(
    (event) => event.status === 'PENDING' || event.status === 'PROCESSING',
  ).length;
  const decidedSignals = events.filter((event) => event.status === 'DECIDED').length;
  const failedSignals = events.filter((event) => event.status === 'FAILED').length;

  const handleScenarioChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextKind = event.target.value as ScenarioKind;
    setSelectedScenario(nextKind);
    const nextPreset = SCENARIO_CATALOG[nextKind];
    const sourceIp = nextPreset?.defaultEvidence?.['sourceIp'];
    if (typeof sourceIp === 'string') {
      setCustomIp(sourceIp);
    }
    setFeedback(null);
  };

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
        <IconBadge tone="info" label="Live telemetry" tooltip="Live telemetry">
          <Radio size={13} aria-hidden="true" />
        </IconBadge>
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
                <IconBadge
                  tone={statusVariant(event.status)}
                  size="compact"
                  label={event.status === 'DECIDED' ? 'Decided' : event.status}
                  tooltip={event.status === 'DECIDED' ? 'Decided' : event.status}
                >
                  {event.status === 'DECIDED' ? (
                    <CheckCircle2 size={13} aria-hidden="true" />
                  ) : event.status === 'FAILED' ? (
                    <TriangleAlert size={13} aria-hidden="true" />
                  ) : (
                    <Activity size={13} aria-hidden="true" />
                  )}
                </IconBadge>
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
      <div className="telemetry-summary" aria-label="Telemetry summary">
        <article className="telemetry-summary-card">
          <span>Loaded signals</span>
          <strong>{events.length}</strong>
          <small>Latest API window</small>
        </article>
        <article className="telemetry-summary-card">
          <span>Awaiting decision</span>
          <strong>{awaitingDecision}</strong>
          <small>Pending or processing</small>
        </article>
        <article className="telemetry-summary-card">
          <span>Decided signals</span>
          <strong>{decidedSignals}</strong>
          <small>Policy result recorded</small>
        </article>
        <article className="telemetry-summary-card">
          <span>Failed signals</span>
          <strong>{failedSignals}</strong>
          <small>Requires attention</small>
        </article>
      </div>
      <form className="scenario-footer" onSubmit={handleInject}>
        <label htmlFor="scenario-select" className="scenario-label">
          Preview a fixed synthetic scenario
        </label>
        <div className="scenario-select-wrapper">
          <select
            id="scenario-select"
            className="input-field scenario-select"
            value={selectedScenario}
            onChange={handleScenarioChange}
            aria-label="Select synthetic scenario"
          >
            {Object.values(SCENARIO_CATALOG).map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.title} (Risk ceiling {item.maxRiskScore} ·{' '}
                {item.decoyTemplate ? 'decoy' : 'quarantine'})
              </option>
            ))}
          </select>
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
