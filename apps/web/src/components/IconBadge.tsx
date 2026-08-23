import React from 'react';

export interface IconBadgeProps {
  readonly children: React.ReactNode;
  readonly tone?: 'observed' | 'model' | 'success' | 'warning' | 'danger' | 'neutral';
  readonly className?: string;
}

export const IconBadge: React.FC<IconBadgeProps> = ({
  children,
  tone = 'neutral',
  className = '',
}) => <span className={`icon-badge icon-badge-${tone} ${className}`}>{children}</span>;
