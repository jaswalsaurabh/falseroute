import React from 'react';
import { Cloud } from 'lucide-react';
import type { ActivityEvent, IntrusionEvent, SystemMode } from '@false-route/contracts';
import type { ApiClient } from '../api/client.js';
import { ActiveResourcesPanel } from '../features/active-responses/ActiveResourcesPanel.js';
import { WorkflowTimeline } from '../features/orchestration/WorkflowTimeline.js';
import { ScenarioInjector } from '../features/simulator/ScenarioInjector.js';

type StreamStatus = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export interface ControlRoomPageProps {
  readonly events: readonly IntrusionEvent[];
  readonly totalEvents: number;
  readonly activityEvents: readonly ActivityEvent[];
  readonly streamStatus: StreamStatus;
  readonly systemMode: SystemMode;
  readonly apiClient: ApiClient;
  readonly onRefresh: () => void;
  readonly onSelectEvent: (event: IntrusionEvent) => void;
  readonly onClearActivity: () => void;
}

export const ControlRoomPage: React.FC<ControlRoomPageProps> = ({
  events,
  totalEvents,
  activityEvents,
  streamStatus,
  systemMode,
  apiClient,
  onRefresh,
  onSelectEvent,
  onClearActivity,
}) => {
  const needsAttention = events.filter(
    (event) => event.status === 'FAILED' || event.status === 'PROCESSING',
  ).length;

  return (
    <>
      <section className="metric-grid" aria-label="Response summary">
        <MetricCard
          label="Recorded signals"
          value={String(totalEvents)}
          detail="Authoritative event total"
          tone="success"
        />
        <MetricCard
          label="Contained routes"
          value="—"
          detail="Lease state unavailable"
          tone="neutral"
        />
        <MetricCard
          label="Median response"
          value="—"
          detail="Timing projection unavailable"
          tone="neutral"
        />
        <MetricCard
          label="Needs attention"
          value={String(needsAttention).padStart(2, '0')}
          detail="Within the latest loaded signals"
          tone={needsAttention > 0 ? 'warning' : 'success'}
        />
      </section>

      <section className="workspace-grid" aria-label="FalseRoute workflow">
        <ScenarioInjector
          client={apiClient}
          events={events}
          onSelectEvent={onSelectEvent}
          onInjected={onRefresh}
        />
        <WorkflowTimeline
          events={activityEvents}
          streamStatus={streamStatus}
          onClear={onClearActivity}
        />
        <ActiveResourcesPanel />
      </section>

      <footer className="app-footer">
        <Cloud size={14} aria-hidden="true" /> All values are synthetic staging data · mode{' '}
        <code>{systemMode}</code> · effects shown are recorded mock states
      </footer>
    </>
  );
};

interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: 'success' | 'warning' | 'neutral';
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, detail, tone }) => (
  <article className="metric-card">
    <div className="eyebrow">{label}</div>
    <strong className="metric-value">{value}</strong>
    <span className={`metric-detail metric-detail-${tone}`}>{detail}</span>
  </article>
);
