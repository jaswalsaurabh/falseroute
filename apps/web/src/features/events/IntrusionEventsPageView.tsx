import React from 'react';
import { type IntrusionEvent } from '@false-route/contracts';
import { Card } from '../../components/Card.js';
import { Pagination, type PageSize } from '../../components/Pagination.js';
import { EventsTable, type EventSort } from './EventsTable.js';
import { EventsToolbar, type EventStatusFilter } from './EventsToolbar.js';

export interface IntrusionEventsPageViewProps {
  readonly events: readonly IntrusionEvent[];
  readonly totalEvents: number;
  readonly page: number;
  readonly pageSize: PageSize;
  readonly search: string;
  readonly status: EventStatusFilter;
  readonly sort: EventSort;
  readonly isLoading: boolean;
  readonly error?: string | null;
  readonly autoRefresh: boolean;
  readonly onSearchChange: (search: string) => void;
  readonly onStatusChange: (status: EventStatusFilter) => void;
  readonly onSortChange: (sort: EventSort) => void;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: PageSize) => void;
  readonly onRefresh: () => void;
  readonly onToggleAutoRefresh: () => void;
  readonly onSelectEvent: (event: IntrusionEvent) => void;
}

export const IntrusionEventsPageView: React.FC<IntrusionEventsPageViewProps> = ({
  events,
  totalEvents,
  page,
  pageSize,
  search,
  status,
  sort,
  isLoading,
  error = null,
  autoRefresh,
  onSearchChange,
  onStatusChange,
  onSortChange,
  onPageChange,
  onPageSizeChange,
  onRefresh,
  onToggleAutoRefresh,
  onSelectEvent,
}) => (
  <section className="intrusion-events-page" aria-label="Intrusion events">
    <Card className="intrusion-events-card">
      <EventsToolbar
        search={search}
        status={status}
        onSearchChange={onSearchChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
        isRefreshing={isLoading}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={onToggleAutoRefresh}
      />
      <EventsTable
        events={events}
        sort={sort}
        onSortChange={onSortChange}
        onSelectEvent={onSelectEvent}
        isLoading={isLoading}
        error={error}
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={totalEvents}
        itemLabel="events"
        disabled={isLoading}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </Card>
  </section>
);
