import React from 'react';
import { Badge } from './Badge.js';
import { Button } from './Button.js';

export interface HeaderProps {
  readonly isUnlocked: boolean;
  readonly onLock?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ isUnlocked, onLock }) => {
  return (
    <header
      style={{
        backgroundColor: 'var(--surface-header)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: 'var(--space-unit-md) var(--space-unit-lg)',
        marginBottom: 'var(--space-unit-lg)',
      }}
    >
      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-unit-md)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-unit-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-unit-sm)' }}>
            <span
              style={{
                fontSize: 'var(--text-size-xl)',
                fontWeight: 800,
                color: 'var(--text-main)',
                letterSpacing: '-0.02em',
              }}
            >
              FALSE<span style={{ color: 'var(--focus-ring)' }}>ROUTE</span>
            </span>
          </div>
          <Badge variant="simulated">SIMULATED CONTAINMENT</Badge>
        </div>

        {isUnlocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-unit-md)' }}>
            <span style={{ fontSize: 'var(--text-size-xs)', color: 'var(--text-muted)' }}>
              CONTROLLED DEMO OPERATOR
            </span>
            <Button variant="secondary" onClick={onLock}>
              Lock Session
            </Button>
          </div>
        )}
      </div>
    </header>
  );
};
