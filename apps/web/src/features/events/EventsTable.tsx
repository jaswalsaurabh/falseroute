import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink } from 'lucide-react';
import { type IntrusionEvent, type ProcessingStatus } from '@false-route/contracts';
import { Badge, type BadgeVariant } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { eventLabel } from '../../scenario-label.js';

export type EventSortField = 'eventType' | 'sourceIp' | 'status' | 'receivedAt';
export type SortDirection = 'asc' | 'desc';

export interface EventSort {
  readonly field: EventSortField;
  readonly direction: SortDirection;
}

export interface EventsTableProps {
  readonly events: readonly IntrusionEvent[];
  readonly sort: EventSort;
  readonly onSortChange: (sort: EventSort) => void;
  readonly onSelectEvent: (event: IntrusionEvent) => void;
  readonly isLoading?: boolean;
  readonly error?: string | null;
  readonly emptyMessage?: string;
}

interface SortableHeaderProps {
  readonly field: EventSortField;
  readonly label: string;
  readonly sort: EventSort;
  readonly onSortChange: (sort: EventSort) => void;
}

const statusVariant: Record<ProcessingStatus, BadgeVariant> = {
  PENDING: 'warning',
  PROCESSING: 'warning',
  ENRICHED: 'info',
  DECIDED: 'success',
  FAILED: 'danger',
};

const SortableHeader: React.FC<SortableHeaderProps> = ({ field, label, sort, onSortChange }) => {
  const isActive = sort.field === field;
  const nextDirection: SortDirection = isActive && sort.direction === 'asc' ? 'desc' : 'asc';
  const ariaSort = isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const SortIcon = isActive ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <th scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className={`events-table-sort${isActive ? ' events-table-sort-active' : ''}`}
        onClick={() => onSortChange({ field, direction: nextDirection })}
      >
        <span>{label}</span>
        <SortIcon size={14} aria-hidden="true" />
        <span className="sr-only">
          {isActive
            ? `Sorted ${ariaSort}. Activate to sort ${nextDirection === 'asc' ? 'ascending' : 'descending'}.`
            : 'Not sorted. Activate to sort ascending.'}
        </span>
      </button>
    </th>
  );
};

export const EventsTable: React.FC<EventsTableProps> = ({
  events,
  sort,
  onSortChange,
  onSelectEvent,
  isLoading = false,
  error = null,
  emptyMessage = 'No intrusion events match the current filters.',
}) => (
  <div className="events-table-region" aria-busy={isLoading}>
    <div className="events-table-scroll">
      <table className="events-table">
        <caption className="sr-only">
          Intrusion events with their observed source, processing state, and received time.
        </caption>
        <thead>
          <tr>
            <SortableHeader
              field="eventType"
              label="Signal"
              sort={sort}
              onSortChange={onSortChange}
            />
            <SortableHeader
              field="sourceIp"
              label="Source"
              sort={sort}
              onSortChange={onSortChange}
            />
            <th scope="col">Target</th>
            <SortableHeader field="status" label="State" sort={sort} onSortChange={onSortChange} />
            <SortableHeader
              field="receivedAt"
              label="Received"
              sort={sort}
              onSortChange={onSortChange}
            />
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <th scope="row">
                <span className="events-table-signal">{eventLabel(event)}</span>
                <code className="events-table-id">{event.id.slice(0, 8)}</code>
              </th>
              <td>
                <code>{event.sourceIp}</code>
              </td>
              <td>{event.targetAsset}</td>
              <td>
                <Badge variant={statusVariant[event.status]}>{event.status}</Badge>
              </td>
              <td>
                <time dateTime={event.receivedAt}>
                  {new Date(event.receivedAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
              </td>
              <td className="events-table-action-cell">
                <Button
                  type="button"
                  variant="secondary"
                  className="events-table-details"
                  aria-label={`View details for ${eventLabel(event)} from ${event.sourceIp}`}
                  onClick={() => onSelectEvent(event)}
                >
                  <span>View details</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {isLoading && events.length === 0 && (
      <div className="events-table-state" role="status">
        Loading intrusion events…
      </div>
    )}
    {!isLoading && error && (
      <div className="events-table-state events-table-error" role="alert">
        {error}
      </div>
    )}
    {!isLoading && !error && events.length === 0 && (
      <div className="events-table-state">{emptyMessage}</div>
    )}
  </div>
);
