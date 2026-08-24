import React from 'react';
import { ArrowUpRight, LockKeyhole, Moon, Sun } from 'lucide-react';
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
}

export const Header: React.FC<HeaderProps> = ({
  isUnlocked,
  onLock,
  route = 'dashboard',
  onNavigate,
  theme = 'light',
  onToggleTheme,
  onInject,
}) => {
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
          <nav className="topbar-nav" aria-label="Primary navigation">
            <RouteToggle route={route} onNavigate={onNavigate} />
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
