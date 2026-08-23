import React from 'react';
import { ExternalLink, ListFilter, RefreshCw } from 'lucide-react';
import { type IntrusionEvent } from '@false-route/contracts';
import { Card } from '../../components/Card.js';
import { Button } from '../../components/Button.js';
import { Badge, type BadgeVariant } from '../../components/Badge.js';
export interface EventListProps {
  readonly events: IntrusionEvent[];
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onSelectEvent: (event: IntrusionEvent) => void;
  readonly autoRefresh: boolean;
  readonly onToggleAutoRefresh: () => void;
}
const statusVariant = (status: string): BadgeVariant =>
  status === 'DECIDED'
    ? 'success'
    : status === 'FAILED'
      ? 'danger'
      : status === 'PROCESSING' || status === 'PENDING'
        ? 'warning'
        : 'neutral';
export const EventList: React.FC<EventListProps> = ({
  events,
  isLoading,
  onRefresh,
  onSelectEvent,
  autoRefresh,
  onToggleAutoRefresh,
}) => (
  <Card
    className="event-history"
    title="Intrusion Events Feed"
    subtitle="Signal history · observed intrusion events and evaluated deception decisions."
    badge={
      <div className="event-actions">
        <Button variant="secondary" onClick={onToggleAutoRefresh}>
          <ListFilter size={14} /> Auto-poll {autoRefresh ? 'on' : 'off'}
        </Button>
        <Button variant="secondary" onClick={onRefresh} isLoading={isLoading}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
    }
  >
    <div className="event-list-header">
      <span>Signal</span>
      <span>Source</span>
      <span>State</span>
      <span>Time</span>
      <span />
    </div>
    {events.length === 0 ? (
      <div className="empty-state">
        No intrusion events recorded yet. Use Telemetry to submit a fixed synthetic scenario.
      </div>
    ) : (
      <div className="event-list">
        {events.map((event) => (
          <button
            type="button"
            aria-label="Inspect"
            className="event-row"
            key={event.id}
            onClick={() => onSelectEvent(event)}
          >
            <span className="event-signal">
              <strong>{event.eventType.replaceAll('_', ' ')}</strong>
              <small>{event.targetAsset}</small>
            </span>
            <code>{event.sourceIp}</code>
            <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
            <time>{new Date(event.receivedAt).toLocaleTimeString()}</time>
            <ExternalLink size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    )}
  </Card>
);
