import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
  type ActivityEvent,
  type SystemMode,
} from '@false-route/contracts';
import { ApiClient } from './api/client.js';
import { Header } from './components/Header.js';
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

  // In-memory API client derived from the operator session token
  const apiClient = useMemo(() => {
    return operatorToken ? new ApiClient(operatorToken) : null;
  }, [operatorToken]);

  const loadEvents = useCallback(async () => {
    if (!apiClient) return;
    setIsLoading(true);
    try {
      const response = await apiClient.listEvents({ limit: 50, offset: 0 });
      setEvents(response.events);

      const currentSelected = selectedEventRef.current;
      if (
        currentSelected &&
        currentSelected.status !== 'DECIDED' &&
        currentSelected.status !== 'FAILED'
      ) {
        const updated = response.events.find((e) => e.id === currentSelected.id);
        if (updated && updated.status !== currentSelected.status) {
          const detail = await apiClient.getEvent(currentSelected.id);
          setSelectedEvent(detail.event);
          setSelectedDecision(detail.decision ?? null);
          setSelectedSimulatedEffect(detail.simulatedEffect ?? null);
        }
      }
    } catch (err) {
      console.error('Failed to fetch intrusion events:', err);
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  // Connect SSE Activity Stream upon session unlock
  useEffect(() => {
    if (!operatorToken) {
      setActivityEvents([]);
      setStreamStatus('DISCONNECTED');
      return;
    }

    const consumer = new ActivityStreamConsumer(operatorToken, '', {
      onEvent: (event) => {
        setActivityEvents((prev) => [event, ...prev.slice(0, 99)]);
        loadEvents();
      },
      onSystemMode: (mode) => setSystemMode(mode),
      onStatusChange: (status) => setStreamStatus(status),
    });

    consumer.start();
    loadEvents();

    return () => {
      consumer.stop();
    };
  }, [operatorToken, loadEvents]);

  const handleSelectEvent = async (event: IntrusionEvent) => {
    setSelectedEvent(event);
    setSelectedDecision(null);
    setSelectedSimulatedEffect(null);

    if (apiClient) {
      try {
        const detail = await apiClient.getEvent(event.id);
        setSelectedEvent(detail.event);
        setSelectedDecision(detail.decision ?? null);
        setSelectedSimulatedEffect(detail.simulatedEffect ?? null);
      } catch (err) {
        console.error('Failed to load event details:', err);
      }
    }
  };

  const handleCloseModal = () => {
    setSelectedEvent(null);
    setSelectedDecision(null);
    setSelectedSimulatedEffect(null);
  };

  return (
    <div>
      <Header
        isUnlocked={Boolean(operatorToken)}
        onLock={() => {
          setOperatorToken(null);
          setEvents([]);
          setActivityEvents([]);
          setSelectedEvent(null);
          setSelectedDecision(null);
          setSelectedSimulatedEffect(null);
        }}
      />

      <main className="app-container">
        {!operatorToken ? (
          <UnlockScreen onUnlock={(token) => setOperatorToken(token)} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-lg)' }}>
            {/* System Mode Bar */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 'var(--space-unit-sm) var(--space-unit-md)',
                backgroundColor: 'var(--surface-card)',
                borderRadius: 'var(--radius-card)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-unit-sm)' }}>
                <span style={{ fontSize: 'var(--text-size-sm)', fontWeight: 600 }}>
                  System Operation Mode:
                </span>
                <span className="badge badge-simulated">{systemMode}</span>
              </div>
              <div style={{ fontSize: 'var(--text-size-xs)', color: 'var(--text-muted)' }}>
                Active Stream: <strong>{streamStatus}</strong>
              </div>
            </div>

            {/* Three-Column Operator Layout */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 'var(--space-unit-lg)',
                alignItems: 'start',
              }}
            >
              {/* Column 1: Scenario Injector */}
              <ScenarioInjector client={apiClient!} onInjected={loadEvents} />

              {/* Column 2: Live Execution Timeline */}
              <WorkflowTimeline
                events={activityEvents}
                streamStatus={streamStatus}
                onClear={() => setActivityEvents([])}
              />

              {/* Column 3: Active Resources & Leases */}
              <ActiveResourcesPanel />
            </div>

            {/* Ingested Event History Table */}
            <EventList
              events={events}
              isLoading={isLoading}
              onRefresh={loadEvents}
              onSelectEvent={handleSelectEvent}
              autoRefresh={autoRefresh}
              onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
            />

            <EventDetailModal
              isOpen={Boolean(selectedEvent)}
              onClose={handleCloseModal}
              event={selectedEvent}
              decision={selectedDecision}
              simulatedEffect={selectedSimulatedEffect}
            />
          </div>
        )}
      </main>
    </div>
  );
};
