import React, { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  CircleDot,
  Eye,
  FileText,
  Radio,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  WandSparkles,
  Workflow,
} from 'lucide-react';
import type { ActivityEvent } from '@false-route/contracts';
import { IconBadge } from '../../components/IconBadge.js';
export interface WorkflowTimelineProps {
  readonly events: readonly ActivityEvent[];
  readonly streamStatus: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  readonly onClear?: () => void;
}
const TERMINAL_LOG_PAGE_SIZE = 8;
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
  const [visibleLogCount, setVisibleLogCount] = useState(TERMINAL_LOG_PAGE_SIZE);
  useEffect(() => {
    if (events.length === 0) setVisibleLogCount(TERMINAL_LOG_PAGE_SIZE);
  }, [events.length]);
  // Progress belongs to the newest correlation, not the whole audit stream.
  const activeCorrelationId = events[0]?.correlationId;
  const workflowEvents = activeCorrelationId
    ? events.filter((event) => event.correlationId === activeCorrelationId)
    : [];
  const stages = new Set(workflowEvents.map((event) => event.stage));
  const completedSteps = workflowEvents.length
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
  const currentStepIndex = completedSteps > 0 ? Math.min(completedSteps - 1, 5) : -1;
  const visibleEvents = events.slice(0, visibleLogCount);
  const hasMoreLogs = visibleEvents.length < events.length;
  const loadMoreLogs = () => {
    setVisibleLogCount((current) => Math.min(current + TERMINAL_LOG_PAGE_SIZE, events.length));
  };
  const handleLogScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (hasMoreLogs && element.scrollTop + element.clientHeight >= element.scrollHeight - 32) {
      loadMoreLogs();
    }
  };

  return (
    <section
      className="pane pane-layer pane-layer-indigo pane-orchestrator"
      aria-labelledby="timeline-heading"
    >
      <div className="pane-header">
        <div>
          <h2 id="timeline-heading">
            <span className="pane-step">02</span>Orchestrator
            <span className="sr-only">2. Autonomous Execution Timeline</span>
          </h2>
          <p>Recommendation, policy, and execution trace</p>
        </div>
        <IconBadge
          tone={
            streamStatus === 'CONNECTED'
              ? 'success'
              : streamStatus === 'DISCONNECTED'
                ? 'danger'
                : 'warning'
          }
          label={streamStatus === 'CONNECTED' ? 'Bounded loop' : streamStatus.toLowerCase()}
          tooltip={
            streamStatus === 'CONNECTED' ? 'Bounded loop' : `Stream ${streamStatus.toLowerCase()}`
          }
        >
          {streamStatus === 'CONNECTED' ? (
            <Workflow size={13} aria-hidden="true" />
          ) : streamStatus === 'DISCONNECTED' ? (
            <TriangleAlert size={13} aria-hidden="true" />
          ) : (
            <Activity size={13} aria-hidden="true" />
          )}
          {streamStatus === 'CONNECTED' && <span className="sr-only">LIVE SSE STREAM</span>}
        </IconBadge>
      </div>
      <div className="workflow-steps" aria-label="Workflow stages">
        {['Ingest', 'Dedupe', 'Analyze', 'Policy', 'Execute', 'Lease'].map((step, index) => (
          <div
            className={`workflow-step ${index < completedSteps ? 'is-complete' : ''} ${index === currentStepIndex ? 'is-current' : ''}`}
            aria-current={index === currentStepIndex ? 'step' : undefined}
            aria-label={`${step}: ${index < completedSteps ? (index === currentStepIndex ? 'current' : 'complete') : 'not started'}`}
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
          <IconBadge tone="warning" label="Derived when available" tooltip="Derived when available">
            <TriangleAlert size={13} aria-hidden="true" />
          </IconBadge>
        </div>
        <p>
          {events[0]?.summary ??
            'Awaiting an observed signal before a risk explanation is available.'}
        </p>
        <div className="provenance-row">
          <IconBadge tone="info" size="compact" label="Observed" tooltip="Observed">
            <Eye size={13} aria-hidden="true" />
          </IconBadge>
          <IconBadge tone="model" size="compact" label="Inferred" tooltip="Inferred">
            <Sparkles size={13} aria-hidden="true" />
          </IconBadge>
          <IconBadge tone="model" size="compact" label="Derived" tooltip="Derived">
            <WandSparkles size={13} aria-hidden="true" />
          </IconBadge>
        </div>
      </div>
      <div className="decision-grid">
        <div>
          <span className="decision-grid-label">
            <ShieldCheck size={13} aria-hidden="true" /> Policy decision
          </span>
          <strong>{workflowEvents[0]?.stage === 'AUTHORIZED' ? 'ALLOW' : '—'}</strong>
          <small>Deterministic authorization</small>
        </div>
        <div>
          <span className="decision-grid-label">
            <Route size={13} aria-hidden="true" /> Allowed tools
          </span>
          <strong>—</strong>
          <small>Closed catalog</small>
        </div>
        <div>
          <span className="decision-grid-label">
            <Activity size={13} aria-hidden="true" /> State
          </span>
          <strong>{workflowEvents[0]?.stage ?? 'IDLE'}</strong>
          <small>Recorded workflow state</small>
        </div>
      </div>
      <div className="terminal">
        <div className="terminal-heading">
          <span>
            <FileText size={14} /> worker / execution-trace.log
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconBadge tone="info" size="compact" label="Streaming" tooltip="Streaming">
              <Radio size={13} aria-hidden="true" />
            </IconBadge>
            {onClear && events.length > 0 && (
              <button
                type="button"
                className="icon-badge icon-badge-neutral icon-badge-compact terminal-clear-btn"
                data-tooltip="Clear activity log"
                data-tooltip-placement="bottom"
                data-tooltip-align="right"
                onClick={onClear}
                aria-label="Clear activity log"
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {events.length === 0 ? (
          <div className="terminal-empty">
            // Awaiting activity stream
            <br />
            // Inject a fixed synthetic scenario to observe the bounded workflow
          </div>
        ) : (
          <>
            <div
              className="terminal-log-scroll"
              role="region"
              aria-label="Execution trace log"
              tabIndex={0}
              onScroll={handleLogScroll}
            >
              <ol className="terminal-log" aria-live="polite">
                {visibleEvents.map((event) => (
                  <li key={`${event.cursor}-${event.eventId}`}>
                    <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
                    <IconBadge
                      tone={stageVariant(event.stage)}
                      size="compact"
                      label={stageLabel(event.stage, event.eventType)}
                      tooltip={stageLabel(event.stage, event.eventType)}
                    >
                      {event.stage === 'COMPLETED' ? (
                        <CheckCircle2 size={12} aria-hidden="true" />
                      ) : event.stage === 'EXECUTED' ? (
                        <CheckCircle2 size={12} aria-hidden="true" />
                      ) : event.stage === 'FAKE_EXECUTED' ? (
                        <Sparkles size={12} aria-hidden="true" />
                      ) : event.stage === 'AUTHORIZED' ? (
                        <ShieldCheck size={12} aria-hidden="true" />
                      ) : event.stage === 'NARROWED' ? (
                        <SlidersHorizontal size={12} aria-hidden="true" />
                      ) : event.stage === 'FAILED' || event.stage === 'REJECTED' ? (
                        <TriangleAlert size={12} aria-hidden="true" />
                      ) : event.stage === 'REQUESTED' ? (
                        <Sparkles size={12} aria-hidden="true" />
                      ) : (
                        <Activity size={12} aria-hidden="true" />
                      )}
                    </IconBadge>
                    <span>{event.summary}</span>
                    <IconBadge
                      tone={
                        event.provenance === 'UNAVAILABLE'
                          ? 'warning'
                          : event.provenance === 'OBSERVED'
                            ? 'info'
                            : 'model'
                      }
                      size="compact"
                      label={event.provenance.toLowerCase()}
                      tooltip={event.provenance.toLowerCase()}
                    >
                      {event.provenance === 'OBSERVED' ? (
                        <Eye size={12} aria-hidden="true" />
                      ) : event.provenance === 'UNAVAILABLE' ? (
                        <TriangleAlert size={12} aria-hidden="true" />
                      ) : event.provenance === 'INFERRED' ? (
                        <Sparkles size={12} aria-hidden="true" />
                      ) : (
                        <WandSparkles size={12} aria-hidden="true" />
                      )}
                    </IconBadge>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
