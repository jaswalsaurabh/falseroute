import React from 'react';
import { Activity, AlertTriangle, Cloud, Clock3, Route } from 'lucide-react';
import {
  IncidentContextSchema,
  IncidentAssessmentSchema,
  type ActivityEvent,
  type IntrusionEvent,
  type SystemMode,
} from '@false-route/contracts';
import type { ApiClient } from '../api/client.js';
import { ActiveResourcesPanel } from '../features/active-responses/ActiveResourcesPanel.js';
import { WorkflowTimeline } from '../features/orchestration/WorkflowTimeline.js';
import { ScenarioInjector } from '../features/simulator/ScenarioInjector.js';
import { AutonomousIntelligencePanel } from '../features/intelligence/AutonomousIntelligencePanel.js';

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
  readonly onViewAllEvents: () => void;
  readonly onClearActivity: () => void;
  readonly campaign: import('@false-route/contracts').CampaignRun | null;
  readonly campaignStarting: boolean;
  readonly onStartCampaign: () => void;
  readonly campaignError: string | null;
  readonly dashboardError: string | null;
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
  onViewAllEvents,
  onClearActivity,
  campaign,
  campaignStarting,
  onStartCampaign,
  campaignError,
  dashboardError,
}) => {
  const needsAttention = events.filter(
    (event) => event.status === 'FAILED' || event.status === 'PROCESSING',
  ).length;
  const activeCorrelationId = activityEvents[0]?.correlationId;
  const currentActivityEvents = activeCorrelationId
    ? activityEvents.filter((event) => event.correlationId === activeCorrelationId)
    : [];
  const assessmentActivity = currentActivityEvents.find(
    (event) => event.eventType === 'GEMINI_ANALYSIS_COMPLETED',
  );
  const assessment = assessmentActivity?.payload?.['assessment'];
  const parsedAssessment = IncidentAssessmentSchema.safeParse(assessment);
  const contextActivity = currentActivityEvents.find(
    (event) => event.eventType === 'INCIDENT_CONTEXT_BUILT',
  );
  const parsedContext = IncidentContextSchema.safeParse(contextActivity?.payload?.['context']);

  return (
    <>
      <section className="metric-grid" aria-label="Response summary">
        <MetricCard
          label="Recorded signals"
          value={String(totalEvents)}
          detail="Authoritative event total"
          tone="success"
          icon={<Activity size={15} aria-hidden="true" />}
        />
        <MetricCard
          label="Contained routes"
          value="—"
          detail="Lease state unavailable"
          tone="neutral"
          icon={<Route size={15} aria-hidden="true" />}
        />
        <MetricCard
          label="Median response"
          value="—"
          detail="Timing projection unavailable"
          tone="neutral"
          icon={<Clock3 size={15} aria-hidden="true" />}
        />
        <MetricCard
          label="Needs attention"
          value={String(needsAttention).padStart(2, '0')}
          detail="Within the latest loaded signals"
          tone={needsAttention > 0 ? 'warning' : 'success'}
          icon={<AlertTriangle size={15} aria-hidden="true" />}
        />
      </section>

      {dashboardError && (
        <div className="page-alert page-alert-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            <strong>Signal refresh failed.</strong> {dashboardError}
          </span>
          <button type="button" className="btn btn-secondary page-alert-action" onClick={onRefresh}>
            Try again
          </button>
        </div>
      )}

      <section className="workspace-grid" aria-label="FalseRoute workflow">
        <ScenarioInjector
          client={apiClient}
          events={events}
          onSelectEvent={onSelectEvent}
          onViewAllEvents={onViewAllEvents}
          onInjected={onRefresh}
        />
        <WorkflowTimeline
          events={activityEvents}
          streamStatus={streamStatus}
          onClear={onClearActivity}
        />
        <ActiveResourcesPanel />
      </section>

      <AutonomousIntelligencePanel
        activityEvents={currentActivityEvents}
        context={parsedContext.success ? parsedContext.data : null}
        assessment={parsedAssessment.success ? parsedAssessment.data : null}
        campaign={campaign}
        campaignStarting={campaignStarting}
        onStartCampaign={onStartCampaign}
        campaignError={campaignError}
      />

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
  readonly icon: React.ReactNode;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, detail, tone, icon }) => (
  <article className="metric-card">
    <div className="metric-heading">
      <span className={`metric-card-icon metric-card-icon-${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="eyebrow">{label}</span>
    </div>
    <strong className="metric-value">{value}</strong>
    <span className={`metric-detail metric-detail-${tone}`}>{detail}</span>
  </article>
);
