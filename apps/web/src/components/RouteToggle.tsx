import React from 'react';
import { Radio } from 'lucide-react';

export interface RouteToggleProps {
  readonly route: 'dashboard' | 'events';
  readonly onNavigate?: ((path: '/' | '/events') => void) | undefined;
  readonly eventCount?: number;
}

export const RouteToggle: React.FC<RouteToggleProps> = ({ route, onNavigate, eventCount = 0 }) => (
  <div className="route-links">
    <a
      href="/"
      className={`route-toggle-button ${route === 'dashboard' ? 'is-active' : ''}`}
      aria-current={route === 'dashboard' ? 'page' : undefined}
      onClick={(event) => {
        if (onNavigate) {
          event.preventDefault();
          onNavigate('/');
        }
      }}
    >
      Control room
    </a>
    <a
      href="/events"
      className={`route-toggle-button ${route === 'events' ? 'is-active' : ''}`}
      aria-label={eventCount > 0 ? `Events, ${eventCount} total events` : 'Events'}
      aria-current={route === 'events' ? 'page' : undefined}
      onClick={(event) => {
        if (onNavigate) {
          event.preventDefault();
          onNavigate('/events');
        }
      }}
    >
      Events
      {eventCount > 0 && (
        <span className="route-count" aria-label={`${eventCount} events`}>
          {eventCount}
        </span>
      )}
      <Radio size={14} aria-hidden="true" />
    </a>
  </div>
);
