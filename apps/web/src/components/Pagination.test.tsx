import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination.js';

describe('Pagination', () => {
  it('announces the current range and supports numbered navigation', () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        page={2}
        pageSize={10}
        totalItems={72}
        itemLabel="events"
        onPageChange={onPageChange}
        onPageSizeChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Showing/).textContent).toContain('11–20 of 72 events');
    expect(screen.getByRole('button', { name: 'Go to page 2' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('offers only the approved page sizes', () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pagination
        page={1}
        pageSize={25}
        totalItems={100}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '10',
      '25',
      '50',
    ]);
    fireEvent.change(select, { target: { value: '50' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });
});
