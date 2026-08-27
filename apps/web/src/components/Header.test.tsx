import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Header } from './Header.js';

describe('Header navigation', () => {
  it('renders the FalseRoute fox logo', () => {
    render(<Header isUnlocked={false} />);

    expect(screen.getByRole('img', { name: 'FalseRoute' })).toBeDefined();
  });

  it('renders both primary routes and marks the control room as active', () => {
    render(<Header isUnlocked route="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Control room' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: /Events/ }).getAttribute('aria-current')).toBe(null);
  });

  it('navigates through the shared route links', () => {
    const onNavigate = vi.fn();
    render(<Header isUnlocked route="events" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('link', { name: 'Control room' }));
    expect(onNavigate).toHaveBeenCalledWith('/');
    expect(screen.getByRole('link', { name: /Events/ }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the event count as navigation context', () => {
    render(<Header isUnlocked route="events" eventCount={12} />);

    expect(screen.getByRole('link', { name: 'Events, 12 total events' })).toBeDefined();
  });
});
