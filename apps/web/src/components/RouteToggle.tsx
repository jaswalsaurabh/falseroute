import React from 'react';
import { Radio } from 'lucide-react';

export interface RouteToggleProps {
  readonly route: 'dashboard' | 'events';
  readonly onNavigate?: ((path: '/' | '/events') => void) | undefined;
}

export const RouteToggle: React.FC<RouteToggleProps> = ({ route, onNavigate }) => (
  <div className="route-toggle" role="group" aria-label="Primary navigation">
    <button
      className={`route-toggle-button ${route === 'dashboard' ? 'is-active' : ''}`}
      type="button"
      aria-pressed={route === 'dashboard'}
      onClick={() => onNavigate?.('/')}
    >
      Control room
    </button>
    <button
      className={`route-toggle-button ${route === 'events' ? 'is-active' : ''}`}
      type="button"
      aria-pressed={route === 'events'}
      onClick={() => onNavigate?.('/events')}
    >
      Events <Radio size={14} aria-hidden="true" />
    </button>
  </div>
);
