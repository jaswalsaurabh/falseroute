import React from 'react';
import { LockKeyhole, Moon, Sun } from 'lucide-react';
import falseRouteLogo from '../../../../assets/branding/false-route-fox-logo.svg';
import falseRouteLogoReversed from '../../../../assets/branding/false-route-fox-logo-reversed.svg';
import { Button } from './Button.js';
import { RouteToggle } from './RouteToggle.js';

export interface HeaderProps {
  readonly isUnlocked: boolean;
  readonly onLock?: () => void;
  readonly route?: 'dashboard' | 'events';
  readonly onNavigate?: (path: '/' | '/events') => void;
  readonly theme?: 'light' | 'dark';
  readonly onToggleTheme?: () => void;
  readonly onInject?: () => void;
  readonly eventCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  isUnlocked,
  onLock,
  route = 'dashboard',
  onNavigate,
  theme = 'light',
  onToggleTheme,
  onInject,
  eventCount = 0,
}) => {
  return (
    <header className="topbar">
      <div className="brand-lockup" role="img" aria-label="FalseRoute">
        <img
          className="brand-logo brand-logo-light"
          src={falseRouteLogo}
          alt=""
          aria-hidden="true"
        />
        <img
          className="brand-logo brand-logo-dark"
          src={falseRouteLogoReversed}
          alt=""
          aria-hidden="true"
        />
      </div>
      {isUnlocked && (
        <>
          <nav className="topbar-nav" aria-label="Primary navigation">
            <RouteToggle route={route} onNavigate={onNavigate} eventCount={eventCount} />
          </nav>
          <div className="topbar-right">
            <div className="topbar-actions">
              <Button
                variant="secondary"
                className="icon-button"
                onClick={onToggleTheme}
                aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} colour theme`}
              >
                {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
              </Button>
              <Button onClick={onInject}>Inject scenario</Button>
              <Button
                variant="secondary"
                className="icon-button"
                onClick={onLock}
                aria-label="Lock operator session"
              >
                <LockKeyhole size={15} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </header>
  );
};
