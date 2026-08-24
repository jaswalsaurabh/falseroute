import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Header } from './Header.js';

describe('Header navigation', () => {
  it('renders both primary routes and marks the control room as active', () => {
    render(<Header isUnlocked route="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Control room' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: /Events/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('navigates through the shared route links', () => {
    const onNavigate = vi.fn();
    render(<Header isUnlocked route="events" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Control room' }));
    expect(onNavigate).toHaveBeenCalledWith('/');
    expect(screen.getByRole('button', { name: /Events/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
