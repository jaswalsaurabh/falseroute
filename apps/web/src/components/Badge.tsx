import React from 'react';

export type BadgeVariant = 'simulated' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface BadgeProps {
  readonly variant?: BadgeVariant;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ variant = 'neutral', children, className = '' }) => {
  return <span className={`badge badge-${variant} ${className}`}>{children}</span>;
};
