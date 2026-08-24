import React from 'react';
import { Check, CircleDot, FileText, Trash2 } from 'lucide-react';
import type { ActivityEvent } from '@false-route/contracts';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
export interface WorkflowTimelineProps {
  readonly events: readonly ActivityEvent[];
  readonly streamStatus: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  readonly onClear?: () => void;
}
const stageVariant = (
  stage: string,
): 'info' | 'warning' | 'success' | 'danger' | 'simulated' | 'neutral' =>
  stage === 'FAILED' || stage === 'REJECTED'
    ? 'danger'
    : stage === 'AUTHORIZED' || stage === 'NARROWED'
      ? 'warning'
      : stage === 'COMPLETED'
        ? 'success'
        : stage === 'FAKE_EXECUTED'
          ? 'simulated'
          : stage === 'RECEIVED'
            ? 'info'
            : 'neutral';
const stageLabel = (stage: string, eventType: string) =>
  eventType === 'GEMINI_ANALYSIS_DEGRADED'
    ? 'AI DEGRADED'
    : stage === 'REQUESTED'
      ? 'REQUESTED (AI)'
      : stage === 'AUTHORIZED'
        ? 'POLICY AUTHORIZED'
        : stage === 'NARROWED'
          ? 'POLICY NARROWED'
          : stage === 'REJECTED'
            ? 'POLICY REJECTED'
            : stage === 'FAKE_EXECUTED'
              ? 'FAKE EXECUTED'
              : stage;
export const WorkflowTimeline: React.FC<WorkflowTimelineProps> = ({
  events,
  streamStatus,
  onClear,
}) => {
  const stages = new Set(events.map((event) => event.stage));
  const completedSteps = events.length
    ? stages.has('COMPLETED') || stages.has('EXECUTED') || stages.has('FAKE_EXECUTED')
      ? 5
      : stages.has('AUTHORIZED') || stages.has('NARROWED') || stages.has('REJECTED')
        ? 4
        : stages.has('ENRICHED') || stages.has('REQUESTED')
          ? 3
          : stages.has('VALIDATED')
            ? 2
            : 1
    : 0;

  return (
    <section className="pane pane-orchestrator" aria-labelledby="timeline-heading">
      <div className="pane-header">
        <div>
          <h2 id="timeline-heading">
            <span className="pane-step">02</span>Orchestrator
            <span className="sr-only">2. Autonomous Execution Timeline</span>
          </h2>
          <p>Recommendation, policy, and execution trace</p>
        </div>
        <Badge
          variant={
            streamStatus === 'CONNECTED'
              ? 'success'
              : streamStatus === 'DISCONNECTED'
                ? 'danger'
                : 'warning'
          }
        >
          {streamStatus === 'CONNECTED' ? (
            <>
              Bounded loop <span className="sr-only">LIVE SSE STREAM</span>
            </>
          ) : (
            streamStatus.toLowerCase()
          )}
        </Badge>
      </div>
      <div className="workflow-steps" aria-label="Workflow stages">
        {['Ingest', 'Dedupe', 'Analyze', 'Policy', 'Execute', 'Lease'].map((step, index) => (
          <div
            className={`workflow-step ${index < completedSteps ? 'is-complete' : ''}`}
            key={step}
          >
            <span>{index < completedSteps ? <Check size={13} /> : <CircleDot size={13} />}</span>
            <small>{step}</small>
          </div>
        ))}
      </div>
      <div className="risk-card">
        <div className="risk-heading">
          <span>Adversary intent &amp; risk</span>
          <Badge variant="warning">Derived when available</Badge>
        </div>
        <p>
          {events[0]?.summary ??
            'Awaiting an observed signal before a risk explanation is available.'}
        </p>
        <div className="provenance-row">
          <Badge variant="observed">Observed</Badge>
          <Badge variant="inferred">Inferred</Badge>
          <Badge variant="derived">Derived</Badge>
        </div>
      </div>
      <div className="decision-grid">
        <div>
          <span>Policy decision</span>
          <strong>{events[0]?.stage === 'AUTHORIZED' ? 'ALLOW' : '—'}</strong>
          <small>Deterministic authorization</small>
        </div>
        <div>
          <span>Allowed tools</span>
          <strong>—</strong>
          <small>Closed catalog</small>
        </div>
        <div>
          <span>State</span>
          <strong>{events[0]?.stage ?? 'IDLE'}</strong>
          <small>Recorded workflow state</small>
        </div>
      </div>
      <div className="terminal">
        <div className="terminal-heading">
          <span>
            <FileText size={14} /> worker / execution-trace.log
          </span>
          {onClear && events.length > 0 && (
            <Button variant="secondary" onClick={onClear} aria-label="Clear activity log">
              <Trash2 size={14} />
            </Button>
          )}
        </div>
        {events.length === 0 ? (
          <div className="terminal-empty">
            // Awaiting activity stream
            <br />
            // Inject a fixed synthetic scenario to observe the bounded workflow
          </div>
        ) : (
          <ol className="terminal-log" aria-live="polite">
            {events.slice(0, 8).map((event) => (
              <li key={`${event.cursor}-${event.eventId}`}>
                <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
                <Badge variant={stageVariant(event.stage)}>
                  {stageLabel(event.stage, event.eventType)}
                </Badge>
                <span>{event.summary}</span>
                <code>{event.provenance.toLowerCase()}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
};
