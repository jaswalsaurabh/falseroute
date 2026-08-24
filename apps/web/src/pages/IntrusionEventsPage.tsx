import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';
import type { IntrusionEvent, ListIntrusionEventsQuery } from '@false-route/contracts';
import type { ApiClient } from '../api/client.js';
import type { PageSize } from '../components/Pagination.js';
import type { EventSort } from '../features/events/EventsTable.js';
import type { EventStatusFilter } from '../features/events/EventsToolbar.js';
import { IntrusionEventsPageView } from '../features/events/IntrusionEventsPageView.js';

export interface IntrusionEventsPageProps {
  readonly client: ApiClient;
  readonly onSelectEvent: (event: IntrusionEvent) => void;
}

const PAGE_SIZES = new Set<PageSize>([10, 25, 50]);
const STATUS_FILTERS = new Set<EventStatusFilter>([
  'ALL',
  'PENDING',
  'PROCESSING',
  'ENRICHED',
  'DECIDED',
  'FAILED',
]);
const SORT_FIELDS = new Set<EventSort['field']>(['eventType', 'sourceIp', 'status', 'receivedAt']);

function initialQueryState() {
  const params = new URLSearchParams(window.location.search);
  const requestedPageSize = Number(params.get('pageSize'));
  const status = params.get('status');
  const sortField = params.get('sortBy');
  const sortDirection = params.get('sortDirection');

  return {
    page: Math.max(1, Number(params.get('page')) || 1),
    pageSize: PAGE_SIZES.has(requestedPageSize as PageSize)
      ? (requestedPageSize as PageSize)
      : (25 as const),
    search: params.get('search')?.slice(0, 100) ?? '',
    status: STATUS_FILTERS.has(status as EventStatusFilter)
      ? (status as EventStatusFilter)
      : ('ALL' as const),
    sort: {
      field: SORT_FIELDS.has(sortField as EventSort['field'])
        ? (sortField as EventSort['field'])
        : ('receivedAt' as const),
      direction: sortDirection === 'asc' ? ('asc' as const) : ('desc' as const),
    },
  };
}

export const IntrusionEventsPage: React.FC<IntrusionEventsPageProps> = ({
  client,
  onSelectEvent,
}) => {
  const initial = useMemo(initialQueryState, []);
  const [events, setEvents] = useState<readonly IntrusionEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState<PageSize>(initial.pageSize);
  const [search, setSearch] = useState(initial.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initial.search);
  const [status, setStatus] = useState<EventStatusFilter>(initial.status);
  const [sort, setSort] = useState<EventSort>(initial.sort);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const requestSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (page !== 1) params.set('page', String(page));
    if (pageSize !== 25) params.set('pageSize', String(pageSize));
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (status !== 'ALL') params.set('status', status);
    if (sort.field !== 'receivedAt') params.set('sortBy', sort.field);
    if (sort.direction !== 'desc') params.set('sortDirection', sort.direction);
    const queryString = params.toString();
    window.history.replaceState({}, '', `/events${queryString ? `?${queryString}` : ''}`);
  }, [debouncedSearch, page, pageSize, sort, status]);

  const loadEvents = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setIsLoading(true);
    setError(null);
    const query: ListIntrusionEventsQuery = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      sortBy: sort.field,
      sortDirection: sort.direction,
      ...(status === 'ALL' ? {} : { status }),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    };

    try {
      const response = await client.listEvents(query);
      if (sequence !== requestSequence.current) return;
      const totalPages = Math.max(1, Math.ceil(response.total / pageSize));
      if (page > totalPages) {
        setPage(totalPages);
        return;
      }
      setEvents(response.events);
      setTotalEvents(response.total);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Unable to load intrusion events');
    } finally {
      if (sequence === requestSequence.current) setIsLoading(false);
    }
  }, [client, debouncedSearch, page, pageSize, sort, status]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void loadEvents(), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadEvents]);

  return (
    <>
      <IntrusionEventsPageView
        events={events}
        totalEvents={totalEvents}
        page={page}
        pageSize={pageSize}
        search={search}
        status={status}
        sort={sort}
        isLoading={isLoading}
        error={error}
        autoRefresh={autoRefresh}
        onSearchChange={setSearch}
        onStatusChange={(value) => {
          setStatus(value);
          setPage(1);
        }}
        onSortChange={(value) => {
          setSort(value);
          setPage(1);
        }}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        onRefresh={() => void loadEvents()}
        onToggleAutoRefresh={() => setAutoRefresh((value) => !value)}
        onSelectEvent={onSelectEvent}
      />
      <footer className="app-footer">
        <Cloud size={14} aria-hidden="true" /> Search, sorting, and pagination use authoritative
        server results.
      </footer>
    </>
  );
};
