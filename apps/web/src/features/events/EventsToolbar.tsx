import React from 'react';
import { ListFilter, RefreshCw, Search } from 'lucide-react';
import { type ProcessingStatus } from '@false-route/contracts';
import { Button } from '../../components/Button.js';
import { Input } from '../../components/Input.js';

export type EventStatusFilter = ProcessingStatus | 'ALL';

export interface EventsToolbarProps {
  readonly search: string;
  readonly status: EventStatusFilter;
  readonly onSearchChange: (search: string) => void;
  readonly onStatusChange: (status: EventStatusFilter) => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
  readonly autoRefresh: boolean;
  readonly onToggleAutoRefresh: () => void;
}

const STATUS_OPTIONS: readonly EventStatusFilter[] = [
  'ALL',
  'PENDING',
  'PROCESSING',
  'ENRICHED',
  'DECIDED',
  'FAILED',
];

export const EventsToolbar: React.FC<EventsToolbarProps> = ({
  search,
  status,
  onSearchChange,
  onStatusChange,
  onRefresh,
  isRefreshing,
  autoRefresh,
  onToggleAutoRefresh,
}) => (
  <div className="events-toolbar" aria-label="Event table controls">
    <div className="events-search">
      <Search size={16} aria-hidden="true" className="events-search-icon" />
      <Input
        id="intrusion-events-search"
        label="Search intrusion events"
        type="search"
        value={search}
        placeholder="Search by signal, source, target, or ID"
        autoComplete="off"
        onChange={(event) => onSearchChange(event.target.value)}
      />
    </div>

    <div className="events-toolbar-right">
      <label className="events-status-filter" htmlFor="intrusion-events-status">
        <span>Status</span>
        <select
          id="intrusion-events-status"
          value={status}
          onChange={(event) => onStatusChange(event.target.value as EventStatusFilter)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === 'ALL' ? 'All statuses' : option}
            </option>
          ))}
        </select>
      </label>

      <div className="events-toolbar-actions">
        <Button
          type="button"
          variant="secondary"
          aria-pressed={autoRefresh}
          onClick={onToggleAutoRefresh}
        >
          <ListFilter size={14} aria-hidden="true" /> Auto-refresh {autoRefresh ? 'on' : 'off'}
        </Button>
        <Button type="button" variant="secondary" onClick={onRefresh} isLoading={isRefreshing}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      </div>
    </div>
  </div>
);
