import React from 'react';

export type IconBadgeTone =
  | 'observed'
  | 'model'
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral'
  | 'info'
  | 'live'
  | 'inferred'
  | 'derived'
  | 'critical'
  | 'simulated';

export type IconBadgeSize = 'default' | 'compact' | 'sm' | 'md';
export type IconBadgePlacement = 'top' | 'bottom';
export type IconBadgeAlign = 'center' | 'left' | 'right';

export interface IconBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly children: React.ReactNode;
  readonly tone?: IconBadgeTone;
  readonly size?: IconBadgeSize;
  readonly tooltip?: string;
  readonly label?: string;
  readonly placement?: IconBadgePlacement;
  readonly align?: IconBadgeAlign;
  readonly className?: string;
  readonly tabIndex?: number;
}

const normalizeTone = (tone: IconBadgeTone): string => {
  switch (tone) {
    case 'live':
    case 'success':
      return 'icon-badge-success';
    case 'observed':
    case 'info':
      return 'icon-badge-info';
    case 'inferred':
    case 'derived':
    case 'simulated':
    case 'model':
      return 'icon-badge-model';
    case 'critical':
    case 'danger':
      return 'icon-badge-danger';
    case 'warning':
      return 'icon-badge-warning';
    case 'neutral':
    default:
      return 'icon-badge-neutral';
  }
};

export const IconBadge: React.FC<IconBadgeProps> = ({
  children,
  tone = 'neutral',
  size = 'default',
  tooltip,
  label,
  placement,
  align,
  className = '',
  tabIndex,
  ...restProps
}) => {
  const accessibleText = label ?? tooltip;
  const isCompact = size === 'compact' || size === 'sm';
  const toneClass = normalizeTone(tone);
  const sizeClass = isCompact ? 'icon-badge-compact' : '';
  const placementClass = placement ? `tooltip-${placement}` : '';
  const alignClass = align ? `tooltip-align-${align}` : '';
  const resolvedTabIndex = tabIndex ?? (tooltip || label ? 0 : undefined);

  return (
    <span
      className={`icon-badge ${toneClass} ${sizeClass} ${placementClass} ${alignClass} ${className}`.trim()}
      data-tooltip={tooltip}
      data-tooltip-placement={placement}
      data-tooltip-align={align}
      aria-label={accessibleText}
      tabIndex={resolvedTabIndex}
      role={resolvedTabIndex !== undefined ? 'img' : undefined}
      {...restProps}
    >
      {children}
      {accessibleText && <span className="sr-only">{accessibleText}</span>}
    </span>
  );
};
