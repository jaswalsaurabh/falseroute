import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type IntrusionEvent } from '@false-route/contracts';
import { EventsTable } from './EventsTable.js';

const event: IntrusionEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: '2026-08-24T10:00:00.000Z',
  receivedAt: '2026-08-24T10:00:01.000Z',
  correlationId: 'corr-events-table-001',
  sourceIp: '198.51.100.25',
  targetAsset: 'mock-admin-portal',
  eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
  failedLoginCount: 3,
  riskIndicators: ['SYNTHETIC_PROBE'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: false,
  status: 'DECIDED',
  provenance: 'OBSERVED',
};

describe('EventsTable', () => {
  it('uses native table semantics and announces the active sort direction', () => {
    render(
      <EventsTable
        events={[event]}
        sort={{ field: 'receivedAt', direction: 'desc' }}
        onSortChange={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getByRole('columnheader', { name: /received/i }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(screen.getByRole('rowheader', { name: /unauthorized access attempt/i })).toBeDefined();
  });

  it('requests the opposite direction when the active sort is selected', () => {
    const onSortChange = vi.fn();
    render(
      <EventsTable
        events={[event]}
        sort={{ field: 'sourceIp', direction: 'asc' }}
        onSortChange={onSortChange}
        onSelectEvent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /source.*sorted ascending/i }));
    expect(onSortChange).toHaveBeenCalledWith({ field: 'sourceIp', direction: 'desc' });
  });

  it('provides an explicit accessible details action', () => {
    const onSelectEvent = vi.fn();
    render(
      <EventsTable
        events={[event]}
        sort={{ field: 'receivedAt', direction: 'desc' }}
        onSortChange={vi.fn()}
        onSelectEvent={onSelectEvent}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'View details for Unauthorized Access Attempt from 198.51.100.25',
      }),
    );
    expect(onSelectEvent).toHaveBeenCalledWith(event);
  });

  it('reports loading, failure, and empty states without inventing event data', () => {
    const { rerender } = render(
      <EventsTable
        events={[]}
        sort={{ field: 'receivedAt', direction: 'desc' }}
        onSortChange={vi.fn()}
        onSelectEvent={vi.fn()}
        isLoading
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading intrusion events');

    rerender(
      <EventsTable
        events={[]}
        sort={{ field: 'receivedAt', direction: 'desc' }}
        onSortChange={vi.fn()}
        onSelectEvent={vi.fn()}
        error="Events are temporarily unavailable."
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable');

    rerender(
      <EventsTable
        events={[]}
        sort={{ field: 'receivedAt', direction: 'desc' }}
        onSortChange={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );
    expect(screen.getByText('No intrusion events match the current filters.')).toBeDefined();
  });
});
