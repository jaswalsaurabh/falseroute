import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Activity, ArrowUpRight, Clock3, Cloud, ShieldAlert, Waves } from 'lucide-react';
import { Toaster } from 'sonner';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
  type ActivityEvent,
  type SystemMode,
} from '@false-route/contracts';
import { ApiClient } from './api/client.js';
import { Header } from './components/Header.js';
import { Badge } from './components/Badge.js';
import { IconBadge } from './components/IconBadge.js';
import { UnlockScreen } from './features/auth/UnlockScreen.js';
import { ScenarioInjector } from './features/simulator/ScenarioInjector.js';
import { WorkflowTimeline } from './features/orchestration/WorkflowTimeline.js';
import { ActiveResourcesPanel } from './features/active-responses/ActiveResourcesPanel.js';
import { EventList } from './features/events/EventList.js';
import { EventDetailModal } from './features/events/EventDetailModal.js';
import { ActivityStreamConsumer } from './features/telemetry/ActivityStreamConsumer.js';

export const App: React.FC = () => {
  const [operatorToken, setOperatorToken] = useState<string | null>(null);
  const [events, setEvents] = useState<IntrusionEvent[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [systemMode, setSystemMode] = useState<SystemMode>('LOCAL_FAKE');
  const [streamStatus, setStreamStatus] = useState<
    'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'
  >('DISCONNECTED');
  const [selectedEvent, setSelectedEvent] = useState<IntrusionEvent | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<DeceptionDecision | null>(null);
  const [selectedSimulatedEffect, setSelectedSimulatedEffect] =
    useState<SimulatedDeceptionEffect | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const selectedEventRef = React.useRef<IntrusionEvent | null>(null);
  selectedEventRef.current = selectedEvent;
  const apiClient = useMemo(
    () => (operatorToken ? new ApiClient(operatorToken) : null),
    [operatorToken],
  );

  const loadEvents = useCallback(async () => {
    if (!apiClient) return;
    setIsLoading(true);
    try {
      const response = await apiClient.listEvents({ limit: 50, offset: 0 });
      setEvents(response.events);
      const current = selectedEventRef.current;
      if (current && current.status !== 'DECIDED' && current.status !== 'FAILED') {
        const updated = response.events.find((event) => event.id === current.id);
        if (updated && updated.status !== current.status) {
          const detail = await apiClient.getEvent(current.id);
          setSelectedEvent(detail.event);
          setSelectedDecision(detail.decision ?? null);
          setSelectedSimulatedEffect(detail.simulatedEffect ?? null);
        }
      }
    } catch (error) {
      console.error('Failed to fetch intrusion events:', error);
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    if (!operatorToken) {
      setActivityEvents([]);
      setStreamStatus('DISCONNECTED');
      return;
    }
    const consumer = new ActivityStreamConsumer(operatorToken, '', {
      onEvent: (event) => {
        setActivityEvents((previous) => [event, ...previous.slice(0, 99)]);
        loadEvents();
      },
      onSystemMode: (mode) => setSystemMode(mode),
      onStatusChange: (status) => setStreamStatus(status),
    });
    consumer.start();
    loadEvents();
    return () => consumer.stop();
  }, [operatorToken, loadEvents]);

  const handleSelectEvent = async (event: IntrusionEvent) => {
    setSelectedEvent(event);
    setSelectedDecision(null);
    setSelectedSimulatedEffect(null);
    if (apiClient)
      try {
        const detail = await apiClient.getEvent(event.id);
        setSelectedEvent(detail.event);
        setSelectedDecision(detail.decision ?? null);
        setSelectedSimulatedEffect(detail.simulatedEffect ?? null);
      } catch (error) {
        console.error('Failed to load event details:', error);
      }
  };
  const clearSelection = () => {
    setSelectedEvent(null);
    setSelectedDecision(null);
    setSelectedSimulatedEffect(null);
  };
  const liveSignals = events.length;
  const containedRoutes = events.filter((event) => event.status === 'DECIDED').length;
  const needsAttention = events.filter(
    (event) => event.status === 'FAILED' || event.status === 'PROCESSING',
  ).length;
  const streamLabel = streamStatus === 'CONNECTED' ? 'Live SSE stream' : streamStatus.toLowerCase();

  return (
    <div className="app-shell">
      <Toaster position="bottom-right" toastOptions={{ className: 'app-toast' }} />
      <Header
        isUnlocked={Boolean(operatorToken)}
        onLock={() => {
          setOperatorToken(null);
          setEvents([]);
          setActivityEvents([]);
          clearSelection();
        }}
      />
      <main className="app-container">
        {!operatorToken ? (
          <UnlockScreen onUnlock={setOperatorToken} />
        ) : (
          <>
            <section className="hero-panel" aria-labelledby="hero-title">
              <div className="hero-copy">
                <Badge variant="info">
                  <Waves size={14} aria-hidden="true" /> Operator console
                </Badge>
                <h1 id="hero-title">
                  See the signal. <span>Shape the response.</span>
                </h1>
                <p>
                  FalseRoute turns synthetic intrusion telemetry into bounded, explainable response
                  decisions. Every effect below is labelled by its provenance.
                </p>
              </div>
              <div className="hero-status">
                <div
                  className={`connection-orb connection-${streamStatus.toLowerCase()}`}
                  aria-hidden="true"
                >
                  <Activity size={24} />
                </div>
                <div>
                  <strong>{streamLabel}</strong>
                  <span>mode: {systemMode}</span>
                </div>
              </div>
            </section>
            <section className="metric-grid" aria-label="Control room summary">
              <MetricCard
                icon={<Activity size={18} />}
                label="Signals today"
                value={String(liveSignals)}
                detail="Observed and recorded activity"
                tone="observed"
              />
              <MetricCard
                icon={<ArrowUpRight size={18} />}
                label="Contained routes"
                value={String(containedRoutes)}
                detail="Decision records available"
                tone="success"
              />
              <MetricCard
                icon={<Clock3 size={18} />}
                label="Median response"
                value="—"
                detail="Insufficient timing sample"
                tone="model"
              />
              <MetricCard
                icon={<ShieldAlert size={18} />}
                label="Needs attention"
                value={String(needsAttention).padStart(2, '0')}
                detail="Pending or failed workflows"
                tone="warning"
              />
            </section>
            <div className="workspace-grid">
              <ScenarioInjector client={apiClient!} onInjected={loadEvents} />
              <WorkflowTimeline
                events={activityEvents}
                streamStatus={streamStatus}
                onClear={() => setActivityEvents([])}
              />
              <ActiveResourcesPanel />
            </div>
            <EventList
              events={events}
              isLoading={isLoading}
              onRefresh={loadEvents}
              onSelectEvent={handleSelectEvent}
              autoRefresh={autoRefresh}
              onToggleAutoRefresh={() => setAutoRefresh((previous) => !previous)}
            />
            <footer className="app-footer">
              <Cloud size={14} aria-hidden="true" /> All values are synthetic staging data · effects
              shown are recorded mock states
            </footer>
            <EventDetailModal
              isOpen={Boolean(selectedEvent)}
              onClose={clearSelection}
              event={selectedEvent}
              decision={selectedDecision}
              simulatedEffect={selectedSimulatedEffect}
            />
          </>
        )}
      </main>
    </div>
  );
};

interface MetricCardProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: 'observed' | 'success' | 'model' | 'warning';
}
const MetricCard: React.FC<MetricCardProps> = ({ icon, label, value, detail, tone }) => (
  <article className="metric-card">
    <div className="metric-heading">
      <IconBadge tone={tone}>{icon}</IconBadge>
      <span>{label}</span>
    </div>
    <strong className="metric-value">{value}</strong>
    <span className={`metric-detail metric-detail-${tone}`}>{detail}</span>
  </article>
);
