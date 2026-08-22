import React from 'react';
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

function getStatusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case 'DECIDED':
      return 'success';
    case 'FAILED':
      return 'danger';
    case 'PROCESSING':
    case 'PENDING':
      return 'warning';
    default:
      return 'neutral';
  }
}

export const EventList: React.FC<EventListProps> = ({
  events,
  isLoading,
  onRefresh,
  onSelectEvent,
  autoRefresh,
  onToggleAutoRefresh,
}) => {
  return (
    <Card
      title="Intrusion Events Feed"
      subtitle="Live feed of observed intrusion signals and evaluated deception containment decisions."
      badge={
        <div style={{ display: 'flex', gap: 'var(--space-unit-sm)', alignItems: 'center' }}>
          <Button
            variant="secondary"
            onClick={onToggleAutoRefresh}
            style={{ fontSize: 'var(--text-size-xs)' }}
          >
            Auto-Poll: {autoRefresh ? 'ON' : 'OFF'}
          </Button>
          <Button
            variant="secondary"
            onClick={onRefresh}
            isLoading={isLoading}
            style={{ fontSize: 'var(--text-size-xs)' }}
          >
            Refresh
          </Button>
        </div>
      }
    >
      {events.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-unit-xl)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-size-sm)',
          }}
        >
          No intrusion events recorded yet. Use the simulator above to submit an event.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-size-sm)' }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  textAlign: 'left',
                }}
              >
                <th style={{ padding: 'var(--space-unit-sm)' }}>Time</th>
                <th style={{ padding: 'var(--space-unit-sm)' }}>Source IP</th>
                <th style={{ padding: 'var(--space-unit-sm)' }}>Target</th>
                <th style={{ padding: 'var(--space-unit-sm)' }}>Type</th>
                <th style={{ padding: 'var(--space-unit-sm)' }}>Decoy?</th>
                <th style={{ padding: 'var(--space-unit-sm)' }}>Status</th>
                <th style={{ padding: 'var(--space-unit-sm)', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.id}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    transition: 'background-color var(--motion-fast)',
                  }}
                >
                  <td
                    style={{
                      padding: 'var(--space-unit-sm)',
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {new Date(event.receivedAt).toLocaleTimeString()}
                  </td>
                  <td
                    style={{
                      padding: 'var(--space-unit-sm)',
                      fontFamily: 'var(--font-family-mono)',
                    }}
                  >
                    {event.sourceIp}
                  </td>
                  <td style={{ padding: 'var(--space-unit-sm)' }}>{event.targetAsset}</td>
                  <td style={{ padding: 'var(--space-unit-sm)', color: 'var(--text-secondary)' }}>
                    {event.eventType}
                  </td>
                  <td style={{ padding: 'var(--space-unit-sm)' }}>
                    {event.usedDecoyCredential ? (
                      <Badge variant="simulated">DECOY</Badge>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>No</span>
                    )}
                  </td>
                  <td style={{ padding: 'var(--space-unit-sm)' }}>
                    <Badge variant={getStatusBadgeVariant(event.status)}>{event.status}</Badge>
                  </td>
                  <td style={{ padding: 'var(--space-unit-sm)', textAlign: 'right' }}>
                    <Button
                      variant="secondary"
                      onClick={() => onSelectEvent(event)}
                      style={{ fontSize: 'var(--text-size-xs)', padding: '2px 8px' }}
                    >
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};
