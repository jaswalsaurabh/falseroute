import React from 'react';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
} from '@false-route/contracts';
import { Modal } from '../../components/Modal.js';
import { Badge } from '../../components/Badge.js';
import { DecisionCard } from './DecisionCard.js';

export interface EventDetailModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly event: IntrusionEvent | null;
  readonly decision: DeceptionDecision | null;
  readonly simulatedEffect?: SimulatedDeceptionEffect | null | undefined;
}

export const EventDetailModal: React.FC<EventDetailModalProps> = ({
  isOpen,
  onClose,
  event,
  decision,
  simulatedEffect,
}) => {
  if (!event) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Intrusion Event: ${event.id.slice(0, 8)}...`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-lg)' }}>
        {/* Event Evidence Section */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 'var(--space-unit-sm)',
            }}
          >
            <h4
              style={{
                fontSize: 'var(--text-size-sm)',
                fontWeight: 700,
                color: 'var(--text-secondary)',
              }}
            >
              INGESTED EVENT EVIDENCE
            </h4>
            <div style={{ display: 'flex', gap: 'var(--space-unit-xs)' }}>
              <Badge variant="neutral">PROVENANCE: {event.provenance}</Badge>
              <Badge variant="simulated">{event.containmentMode}</Badge>
              <Badge
                variant={
                  event.status === 'DECIDED'
                    ? 'success'
                    : event.status === 'FAILED'
                      ? 'danger'
                      : 'warning'
                }
              >
                {event.status}
              </Badge>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--space-unit-sm)',
              padding: 'var(--space-unit-md)',
              backgroundColor: 'var(--surface-card-accent)',
              borderRadius: 'var(--radius-card)',
              fontSize: 'var(--text-size-sm)',
            }}
          >
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Correlation ID: </span>
              <code>{event.correlationId}</code>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Source IP: </span>
              <strong>{event.sourceIp}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Target Asset: </span>
              <strong>{event.targetAsset}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Event Type: </span>
              <span>{event.eventType}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Failed Attempts: </span>
              <span>{event.failedLoginCount}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Decoy Credential: </span>
              <strong>{event.usedDecoyCredential ? 'YES' : 'NO'}</strong>
              {event.usedDecoyCredential && event.decoyIdentifier && (
                <span style={{ color: 'var(--status-simulated-text)' }}>
                  {' '}
                  ({event.decoyIdentifier})
                </span>
              )}
            </div>
          </div>

          {event.riskIndicators.length > 0 && (
            <div
              style={{
                marginTop: 'var(--space-unit-xs)',
                display: 'flex',
                gap: 'var(--space-unit-xs)',
                flexWrap: 'wrap',
              }}
            >
              {event.riskIndicators.map((indicator) => (
                <Badge key={indicator} variant="neutral">
                  {indicator}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Deception Decision Section */}
        <div>
          <h4
            style={{
              fontSize: 'var(--text-size-sm)',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-unit-sm)',
            }}
          >
            EVALUATED DECEPTION OUTCOME
          </h4>
          {decision ? (
            <DecisionCard decision={decision} simulatedEffect={simulatedEffect} />
          ) : (
            <div
              style={{
                padding: 'var(--space-unit-lg)',
                textAlign: 'center',
                backgroundColor: 'var(--surface-card-accent)',
                borderRadius: 'var(--radius-card)',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-size-sm)',
              }}
            >
              {event.status === 'PENDING' || event.status === 'PROCESSING'
                ? 'Processing in background... Click refresh or wait for the worker tick to record the decision.'
                : 'No deception decision recorded for this event.'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
