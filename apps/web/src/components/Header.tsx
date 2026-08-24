import React from 'react';
import { ArrowUpRight, LockKeyhole, Moon, Radio, Sun } from 'lucide-react';
import { Button } from './Button.js';

export interface HeaderProps {
  readonly isUnlocked: boolean;
  readonly onLock?: () => void;
  readonly route?: 'dashboard' | 'events';
  readonly onNavigate?: (path: '/' | '/events') => void;
  readonly systemMode?: string;
  readonly streamStatus?: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  readonly theme?: 'light' | 'dark';
  readonly onToggleTheme?: () => void;
  readonly onInject?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isUnlocked,
  onLock,
  route = 'dashboard',
  onNavigate,
  systemMode = 'LOCAL_FAKE',
  streamStatus = 'DISCONNECTED',
  theme = 'light',
  onToggleTheme,
  onInject,
}) => {
  const handleNavigate = (event: React.MouseEvent<HTMLAnchorElement>, path: '/' | '/events') => {
    if (!onNavigate) return;
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <ArrowUpRight size={20} strokeWidth={3} />
        </div>
        <div>
          <div className="brand-name">
            False<span>Route</span>
          </div>
          <div className="brand-subtitle">Autonomous control plane</div>
        </div>
      </div>
      {isUnlocked && (
        <>
          <div className="topbar-status" aria-label="System status">
            <span className="status-chip">
              <span className="status-dot status-dot-live" />
              <strong>{systemMode === 'LOCAL_FAKE' ? 'Simulated mode' : 'Autonomous mode'}</strong>
            </span>
            <span className="status-chip">
              <span
                className={`status-dot ${streamStatus === 'CONNECTED' ? 'status-dot-observed' : 'status-dot-warning'}`}
              />
              {streamStatus === 'CONNECTED'
                ? 'Activity stream connected'
                : `Stream ${streamStatus.toLowerCase()}`}
            </span>
            <span className="status-chip">
              <span className="status-dot status-dot-warning" /> Resource state unavailable
            </span>
          </div>
          <div className="topbar-actions">
            <Button
              variant="secondary"
              className="icon-button"
              onClick={onToggleTheme}
              aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} colour theme`}
            >
              {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
            </Button>
            <nav className="topbar-nav" aria-label="Primary navigation">
              <a
                className={`topbar-link ${route === 'events' ? 'is-active' : ''}`}
                href="/events"
                aria-current={route === 'events' ? 'page' : undefined}
                onClick={(event) => handleNavigate(event, '/events')}
              >
                Events <Radio size={14} aria-hidden="true" />
              </a>
            </nav>
            {route === 'dashboard' ? (
              <Button onClick={onInject}>Inject scenario</Button>
            ) : (
              <Button onClick={() => onNavigate?.('/')}>Control room</Button>
            )}
            <Button
              variant="secondary"
              className="icon-button"
              onClick={onLock}
              aria-label="Lock operator session"
            >
              <LockKeyhole size={15} aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
    </header>
  );
};
