import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Check, TriangleAlert } from 'lucide-react';
import { IconBadge } from './IconBadge.js';

describe('IconBadge Component', () => {
  it('renders children and applies default neutral tone', () => {
    const { container } = render(
      <IconBadge>
        <Check size={13} data-testid="check-icon" />
      </IconBadge>,
    );
    expect(screen.getByTestId('check-icon')).toBeDefined();
    expect(container.firstElementChild?.classList.contains('icon-badge-neutral')).toBe(true);
  });

  it('renders semantic tones and compact size classes correctly', () => {
    const { container: successContainer } = render(
      <IconBadge tone="success" size="compact" tooltip="Decided">
        <Check size={13} />
      </IconBadge>,
    );
    expect(successContainer.firstElementChild?.classList.contains('icon-badge-success')).toBe(true);
    expect(successContainer.firstElementChild?.classList.contains('icon-badge-compact')).toBe(true);

    const { container: warningContainer } = render(
      <IconBadge tone="warning" tooltip="Warning">
        <TriangleAlert size={13} />
      </IconBadge>,
    );
    expect(warningContainer.firstElementChild?.classList.contains('icon-badge-warning')).toBe(true);
  });

  it('exposes accessible label and data-tooltip attribute for screen readers and tooltips', () => {
    render(
      <IconBadge tone="info" label="Live telemetry" tooltip="Live telemetry">
        <Check size={13} />
      </IconBadge>,
    );

    const element = screen.getByLabelText('Live telemetry');
    expect(element).toBeDefined();
    expect(element.getAttribute('data-tooltip')).toBe('Live telemetry');
    expect(element.getAttribute('tabIndex')).toBe('0');
    expect(element.getAttribute('role')).toBe('img');
  });

  it('renders hidden accessible text for screen readers', () => {
    render(
      <IconBadge tone="model" tooltip="Inferred">
        <Check size={13} />
      </IconBadge>,
    );

    expect(screen.getByText('Inferred')).toBeDefined();
  });

  it('supports placement and align props for tooltip positioning', () => {
    const { container } = render(
      <IconBadge tone="info" tooltip="Streaming" placement="bottom" align="right">
        <Check size={13} />
      </IconBadge>,
    );

    expect(container.firstElementChild?.classList.contains('tooltip-bottom')).toBe(true);
    expect(container.firstElementChild?.classList.contains('tooltip-align-right')).toBe(true);
    expect(container.firstElementChild?.getAttribute('data-tooltip-placement')).toBe('bottom');
    expect(container.firstElementChild?.getAttribute('data-tooltip-align')).toBe('right');
  });
});
