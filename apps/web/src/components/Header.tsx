import React from 'react';
import { Activity, LockKeyhole, Radio, ShieldCheck } from 'lucide-react';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { IconBadge } from './IconBadge.js';

export interface HeaderProps {
  readonly isUnlocked: boolean;
  readonly onLock?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ isUnlocked, onLock }) => {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <IconBadge tone="model">
          <ShieldCheck size={20} aria-hidden="true" />
        </IconBadge>
        <div>
          <div className="brand-name">
            False<span>Route</span>
          </div>
          <div className="brand-subtitle">Autonomous response control room</div>
        </div>
      </div>
      {isUnlocked && (
        <div className="topbar-actions">
          <Badge variant="simulated">
            <Radio size={14} aria-hidden="true" /> SIMULATED CONTAINMENT
          </Badge>
          <Badge variant="success">
            <Activity size={14} aria-hidden="true" /> CONTROLLED DEMO
          </Badge>
          <Button variant="secondary" onClick={onLock} aria-label="Lock operator session">
            <LockKeyhole size={15} aria-hidden="true" /> Lock session
          </Button>
        </div>
      )}
    </header>
  );
};
