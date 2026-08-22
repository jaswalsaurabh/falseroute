import React from 'react';
import type { ActivityEvent } from '@false-route/contracts';

export interface WorkflowTimelineProps {
  readonly events: readonly ActivityEvent[];
  readonly streamStatus: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  readonly onClear?: () => void;
}

function getBadgeClass(stage: string, eventType?: string): string {
  if (eventType === 'GEMINI_ANALYSIS_DEGRADED') {
    return 'badge-warning';
  }
  switch (stage) {
    case 'RECEIVED':
    case 'REQUESTED':
    case 'ENRICHED':
      return 'badge-info';
    case 'AUTHORIZED':
    case 'NARROWED':
      return 'badge-warning';
    case 'FAKE_EXECUTED':
      return 'badge-simulated';
    case 'COMPLETED':
      return 'badge-success';
    case 'REJECTED':
    case 'FAILED':
      return 'badge-danger';
    default:
      return 'badge-neutral';
  }
}

function getStageDisplay(evt: ActivityEvent): string {
  if (evt.eventType === 'GEMINI_ANALYSIS_DEGRADED') {
    return 'AI DEGRADED';
  }
  switch (evt.stage) {
    case 'REQUESTED':
      return 'REQUESTED (AI)';
    case 'AUTHORIZED':
      return 'POLICY AUTHORIZED';
    case 'NARROWED':
      return 'POLICY NARROWED';
    case 'REJECTED':
      return 'POLICY REJECTED';
    case 'FAKE_EXECUTED':
      return 'FAKE EXECUTED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    default:
      return evt.stage;
  }
}

export const WorkflowTimeline: React.FC<WorkflowTimelineProps> = ({
  events,
  streamStatus,
  onClear,
}) => {
  const getStatusBadge = () => {
    switch (streamStatus) {
      case 'CONNECTED':
        return <span className="badge badge-success">LIVE SSE STREAM</span>;
      case 'CONNECTING':
      case 'RECONNECTING':
        return <span className="badge badge-warning">{streamStatus}</span>;
      case 'DISCONNECTED':
        return <span className="badge badge-danger">STREAM OFFLINE</span>;
    }
  };

  return (
    <section className="card" aria-labelledby="timeline-heading">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-unit-md)',
        }}
      >
        <div>
          <h2 id="timeline-heading" style={{ fontSize: 'var(--text-size-lg)' }}>
            2. Autonomous Execution Timeline
          </h2>
          <div style={{ marginTop: 'var(--space-unit-xs)' }}>{getStatusBadge()}</div>
        </div>
        {onClear && events.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={onClear}>
            Clear Log
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-unit-xl)',
            color: 'var(--text-muted)',
          }}
        >
          <p>No activity events recorded yet.</p>
          <p style={{ fontSize: 'var(--text-size-xs)', marginTop: 'var(--space-unit-xs)' }}>
            Inject an attack scenario from Column 1 to observe real-time control plane actions.
          </p>
        </div>
      ) : (
        <ol
          style={{
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-unit-sm)',
            maxHeight: '600px',
            overflowY: 'auto',
            paddingRight: 'var(--space-unit-xs)',
          }}
          aria-live="polite"
        >
          {events.map((evt) => (
            <li
              key={`${evt.cursor}-${evt.eventId}`}
              style={{
                padding: 'var(--space-unit-sm) var(--space-unit-md)',
                backgroundColor: 'var(--surface-input)',
                borderRadius: 'var(--radius-card)',
                borderLeft: '4px solid var(--border-default)',
                fontSize: 'var(--text-size-xs)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 'var(--space-unit-xs)',
                }}
              >
                <span className={`badge ${getBadgeClass(evt.stage, evt.eventType)}`}>
                  {getStageDisplay(evt)}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>
                  #{evt.cursor} • {new Date(evt.occurredAt).toLocaleTimeString()}
                </span>
              </div>
              <p
                style={{
                  fontWeight: 600,
                  color: 'var(--text-main)',
                  marginBottom: 'var(--space-unit-xs)',
                }}
              >
                {evt.summary}
              </p>
              <div style={{ color: 'var(--text-muted)' }}>
                <span>
                  Type: <code>{evt.eventType}</code>
                </span>{' '}
                |{' '}
                <span>
                  Provenance: <code>{evt.provenance}</code>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
