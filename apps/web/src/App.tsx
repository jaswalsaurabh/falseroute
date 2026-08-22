import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { type IntrusionEvent, type DeceptionDecision } from '@false-route/contracts';
import { ApiClient } from './api/client.js';
import { Header } from './components/Header.js';
import { UnlockScreen } from './features/auth/UnlockScreen.js';
import { EventSimulatorForm } from './features/simulator/EventSimulatorForm.js';
import { EventList } from './features/events/EventList.js';
import { EventDetailModal } from './features/events/EventDetailModal.js';

export const App: React.FC = () => {
  const [operatorToken, setOperatorToken] = useState<string | null>(null);
  const [events, setEvents] = useState<IntrusionEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<IntrusionEvent | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<DeceptionDecision | null>(null);
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

      // If an event modal is currently open and was pending/processing, refresh its details if resolved
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
        }
      }
    } catch (err) {
      console.error('Failed to fetch intrusion events:', err);
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  // Periodic polling for background event decisions
  useEffect(() => {
    if (!operatorToken || !autoRefresh) return;

    loadEvents();
    const interval = setInterval(() => {
      loadEvents();
    }, 2000);

    return () => clearInterval(interval);
  }, [operatorToken, autoRefresh, loadEvents]);

  const handleSelectEvent = async (event: IntrusionEvent) => {
    setSelectedEvent(event);
    setSelectedDecision(null);

    if (apiClient) {
      try {
        const detail = await apiClient.getEvent(event.id);
        setSelectedEvent(detail.event);
        setSelectedDecision(detail.decision ?? null);
      } catch (err) {
        console.error('Failed to load event details:', err);
      }
    }
  };

  const handleCloseModal = () => {
    setSelectedEvent(null);
    setSelectedDecision(null);
  };

  return (
    <div>
      <Header
        isUnlocked={Boolean(operatorToken)}
        onLock={() => {
          setOperatorToken(null);
          setEvents([]);
        }}
      />

      <main className="app-container">
        {!operatorToken ? (
          <UnlockScreen onUnlock={(token) => setOperatorToken(token)} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-lg)' }}>
            <EventSimulatorForm client={apiClient!} onEventCreated={loadEvents} />

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
            />
          </div>
        )}
      </main>
    </div>
  );
};
