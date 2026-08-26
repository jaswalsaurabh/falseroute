import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import {
  type ActivityEvent,
  type DeceptionDecision,
  type IntrusionEvent,
  type SimulatedDeceptionEffect,
  type SystemMode,
  type CampaignRun,
} from '@false-route/contracts';
import { ApiClient } from './api/client.js';
import { Header } from './components/Header.js';
import { EventDetailModal } from './features/events/EventDetailModal.js';
import { UnlockScreen } from './features/auth/UnlockScreen.js';
import { ActivityStreamConsumer } from './features/telemetry/ActivityStreamConsumer.js';
import { ControlRoomPage } from './pages/ControlRoomPage.js';
import { IntrusionEventsPage } from './pages/IntrusionEventsPage.js';

type Route = 'dashboard' | 'events';
type StreamStatus = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
type Theme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'falseroute-theme';

export const readThemePreference = (): Theme => {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage can be unavailable in hardened browser contexts; use the document default.
  }
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
};

const currentRoute = (): Route => (window.location.pathname === '/events' ? 'events' : 'dashboard');

export const App: React.FC = () => {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [operatorToken, setOperatorToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [events, setEvents] = useState<IntrusionEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [systemMode, setSystemMode] = useState<SystemMode>('LOCAL_FAKE');
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('DISCONNECTED');
  const [campaign, setCampaign] = useState<CampaignRun | null>(null);
  const [campaignStarting, setCampaignStarting] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<IntrusionEvent | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<DeceptionDecision | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<SimulatedDeceptionEffect | null>(null);
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const selectedEventRef = useRef<IntrusionEvent | null>(null);
  const loadEventsTimerRef = useRef<number | null>(null);
  selectedEventRef.current = selectedEvent;
  const apiClient = useMemo(
    () => (operatorToken === null ? null : new ApiClient(operatorToken)),
    [operatorToken],
  );

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme still applies for this session when persistent storage is unavailable.
    }
  }, [theme]);

  const navigate = useCallback((path: '/' | '/events') => {
    window.history.pushState({}, '', path);
    setRoute(path === '/events' ? 'events' : 'dashboard');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const client = new ApiClient(null);
    // The session cookie is HttpOnly, so the browser cannot reliably tell us
    // whether a valid cookie session exists before asking the API.
    void client
      .validateCredentials()
      .then(() => {
        if (!cancelled) setOperatorToken((current) => current ?? '');
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadEvents = useCallback(async () => {
    if (!apiClient) return;
    try {
      const response = await apiClient.listEvents({ limit: 50, offset: 0 });
      setEvents(response.events);
      setTotalEvents(response.total);
      const current = selectedEventRef.current;
      const updated = current && response.events.find((event) => event.id === current.id);
      if (
        current &&
        updated &&
        updated.status !== current.status &&
        current.status !== 'DECIDED' &&
        current.status !== 'FAILED'
      ) {
        const detail = await apiClient.getEvent(current.id);
        setSelectedEvent(detail.event);
        setSelectedDecision(detail.decision ?? null);
        setSelectedEffect(detail.simulatedEffect ?? null);
      }
    } catch (error) {
      console.error('Failed to fetch intrusion events:', error);
    }
  }, [apiClient]);

  const scheduleLoadEvents = useCallback(() => {
    if (loadEventsTimerRef.current !== null) return;
    loadEventsTimerRef.current = window.setTimeout(() => {
      loadEventsTimerRef.current = null;
      void loadEvents();
    }, 500);
  }, [loadEvents]);

  const startCampaign = useCallback(async () => {
    if (!apiClient) return;
    setCampaignStarting(true);
    setCampaignError(null);
    try {
      setCampaign(await apiClient.startCampaign());
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : 'Unable to start campaign');
    } finally {
      setCampaignStarting(false);
    }
  }, [apiClient]);

  useEffect(() => {
    if (operatorToken === null) {
      setActivityEvents([]);
      setCampaign(null);
      setCampaignError(null);
      setStreamStatus('DISCONNECTED');
      return;
    }
    const consumer = new ActivityStreamConsumer(operatorToken, '', {
      onEvent: (event) => {
        setActivityEvents((previous) => [event, ...previous.slice(0, 99)]);
        scheduleLoadEvents();
      },
      onSystemMode: setSystemMode,
      onStatusChange: setStreamStatus,
    });
    consumer.start();
    void loadEvents();
    return () => consumer.stop();
  }, [operatorToken, loadEvents, scheduleLoadEvents]);

  useEffect(() => {
    if (
      !apiClient ||
      !campaign ||
      campaign.status === 'COMPLETED' ||
      campaign.status === 'FAILED'
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void apiClient
        .getCampaign(campaign.campaignId)
        .then(setCampaign)
        .catch((error: unknown) =>
          setCampaignError(error instanceof Error ? error.message : 'Unable to refresh campaign'),
        );
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [apiClient, campaign]);

  useEffect(() => {
    // The events page owns filtered polling; keep this lightweight refresh scoped
    // to the dashboard so the two routes do not issue duplicate list requests.
    if (operatorToken === null || route !== 'dashboard') return;
    const timer = window.setInterval(() => void loadEvents(), 15_000);
    return () => window.clearInterval(timer);
  }, [operatorToken, route, loadEvents]);

  const selectEvent = async (event: IntrusionEvent) => {
    setSelectedEvent(event);
    setSelectedDecision(null);
    setSelectedEffect(null);
    if (!apiClient) return;
    try {
      const detail = await apiClient.getEvent(event.id);
      setSelectedEvent(detail.event);
      setSelectedDecision(detail.decision ?? null);
      setSelectedEffect(detail.simulatedEffect ?? null);
    } catch (error) {
      console.error('Failed to load event details:', error);
    }
  };

  const clearSelection = () => {
    setSelectedEvent(null);
    setSelectedDecision(null);
    setSelectedEffect(null);
  };

  const lockSession = () => {
    void apiClient?.logout().catch(() => undefined);
    setOperatorToken(null);
    setEvents([]);
    setTotalEvents(0);
    setActivityEvents([]);
    setCampaign(null);
    setCampaignError(null);
    clearSelection();
  };

  const focusScenarioInjector = () => {
    if (route !== 'dashboard') navigate('/');
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('#scenario-injector')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      document.querySelector<HTMLElement>('#scenario-injector button')?.focus();
    }, 0);
  };

  return (
    <div className="app-shell">
      <Toaster
        position="bottom-right"
        theme={theme}
        closeButton
        toastOptions={{ className: 'app-toast', duration: 2800 }}
      />
      <Header
        isUnlocked={operatorToken !== null}
        onLock={lockSession}
        route={route}
        onNavigate={navigate}
        theme={theme}
        onToggleTheme={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}
        onInject={focusScenarioInjector}
        eventCount={totalEvents}
      />
      <main className="app-container">
        {!authChecked ? (
          <div className="loading-state">Restoring operator session…</div>
        ) : operatorToken === null ? (
          <UnlockScreen onUnlock={setOperatorToken} />
        ) : route === 'events' ? (
          <IntrusionEventsPage client={apiClient!} onSelectEvent={selectEvent} />
        ) : (
          <ControlRoomPage
            events={events}
            totalEvents={totalEvents}
            activityEvents={activityEvents}
            streamStatus={streamStatus}
            systemMode={systemMode}
            apiClient={apiClient!}
            onRefresh={loadEvents}
            onSelectEvent={selectEvent}
            onViewAllEvents={() => navigate('/events')}
            onClearActivity={() => setActivityEvents([])}
            campaign={campaign}
            campaignStarting={campaignStarting}
            onStartCampaign={() => void startCampaign()}
            campaignError={campaignError}
          />
        )}
      </main>
      <EventDetailModal
        isOpen={Boolean(selectedEvent)}
        onClose={clearSelection}
        event={selectedEvent}
        decision={selectedDecision}
        simulatedEffect={selectedEffect}
      />
    </div>
  );
};
