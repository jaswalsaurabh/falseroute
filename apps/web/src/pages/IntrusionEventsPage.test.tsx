import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { IntrusionEventsPage } from './IntrusionEventsPage.js';

describe('IntrusionEventsPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/events');
  });

  it('keeps server-side filters, sorting, and pagination in the typed query', async () => {
    const listEvents = vi.fn().mockResolvedValue({
      events: [],
      total: 30,
      limit: 25,
      offset: 0,
    });
    const client = { listEvents } as unknown as ApiClient;

    render(<IntrusionEventsPage client={client} onSelectEvent={vi.fn()} />);

    await waitFor(() =>
      expect(listEvents).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        sortBy: 'receivedAt',
        sortDirection: 'desc',
      }),
    );

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'FAILED' } });
    await waitFor(() =>
      expect(listEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'FAILED', offset: 0 }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Signal/ }));
    await waitFor(() =>
      expect(listEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'eventType', sortDirection: 'asc' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() =>
      expect(listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })),
    );

    fireEvent.change(screen.getByLabelText('Search intrusion events'), {
      target: { value: 'probe' },
    });
    await waitFor(
      () =>
        expect(listEvents).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'probe', status: 'FAILED' }),
        ),
      { timeout: 1000 },
    );

    expect(window.location.search).toContain('search=probe');
    expect(window.location.search).toContain('status=FAILED');
  });
});
