import React from 'react';

export interface CardProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly badge?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export const Card: React.FC<CardProps> = ({ title, subtitle, badge, children, className = '' }) => {
  return (
    <div className={`card ${className}`}>
      {(title || badge) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-unit-md)',
          }}
        >
          <div>
            {title && (
              <h3
                style={{
                  fontSize: 'var(--text-size-lg)',
                  color: 'var(--text-main)',
                  fontWeight: 600,
                }}
              >
                {title}
              </h3>
            )}
            {subtitle && (
              <p style={{ fontSize: 'var(--text-size-sm)', color: 'var(--text-secondary)' }}>
                {subtitle}
              </p>
            )}
          </div>
          {badge && <div>{badge}</div>}
        </div>
      )}
      {children}
    </div>
  );
};
