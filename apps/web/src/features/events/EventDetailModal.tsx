import React from 'react';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type SimulatedDeceptionEffect,
} from '@false-route/contracts';
import { Modal } from '../../components/Modal.js';
import { Badge } from '../../components/Badge.js';
import { DecisionCard } from './DecisionCard.js';
import { eventLabel } from '../../scenario-label.js';

export interface EventDetailModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly event: IntrusionEvent | null;
  readonly decision: DeceptionDecision | null;
  readonly simulatedEffect?: SimulatedDeceptionEffect | null | undefined;
  readonly detailError?: string | null;
  readonly onRetry?: (() => void) | undefined;
}

export const EventDetailModal: React.FC<EventDetailModalProps> = ({
  isOpen,
  onClose,
  event,
  decision,
  simulatedEffect,
  detailError = null,
  onRetry,
}) => {
  if (!event) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${eventLabel(event)}: ${event.id.slice(0, 8)}...`}
      className="event-detail-modal"
    >
      <div className="event-detail-content">
        {detailError && (
          <div className="page-alert page-alert-error" role="alert">
            <span>
              <strong>Event details unavailable.</strong> {detailError}
            </span>
            {onRetry && (
              <button
                type="button"
                className="btn btn-secondary page-alert-action"
                onClick={onRetry}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {/* Event Evidence Section */}
        <section className="event-detail-section" aria-labelledby="event-evidence-heading">
          <div className="event-detail-section-heading">
            <h4 id="event-evidence-heading">Ingested event evidence</h4>
            <div className="event-detail-badges">
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

          <dl className="event-detail-metadata">
            <div>
              <dt>Correlation ID</dt>
              <dd>
                <code>{event.correlationId}</code>
              </dd>
            </div>
            <div>
              <dt>Source IP</dt>
              <dd>
                <strong>{event.sourceIp}</strong>
              </dd>
            </div>
            <div>
              <dt>Target asset</dt>
              <dd>
                <strong>{event.targetAsset}</strong>
              </dd>
            </div>
            <div>
              <dt>Event type</dt>
              <dd>{event.eventType}</dd>
            </div>
            {event.scenarioKind && (
              <div>
                <dt>Scenario</dt>
                <dd>
                  <strong>{eventLabel(event)}</strong>
                </dd>
              </div>
            )}
            <div>
              <dt>Failed attempts</dt>
              <dd>{event.failedLoginCount}</dd>
            </div>
            <div>
              <dt>Decoy credential</dt>
              <dd>
                <strong>{event.usedDecoyCredential ? 'YES' : 'NO'}</strong>
                {event.usedDecoyCredential && event.decoyIdentifier && (
                  <span className="event-detail-accent"> ({event.decoyIdentifier})</span>
                )}
              </dd>
            </div>
          </dl>

          {event.riskIndicators.length > 0 && (
            <div className="event-detail-risk-indicators">
              {event.riskIndicators.map((indicator) => (
                <Badge key={indicator} variant="neutral">
                  {indicator}
                </Badge>
              ))}
            </div>
          )}
        </section>

        {/* Deception Decision Section */}
        <section className="event-detail-section" aria-labelledby="event-outcome-heading">
          <h4 id="event-outcome-heading">Evaluated deception outcome</h4>
          {decision ? (
            <DecisionCard decision={decision} simulatedEffect={simulatedEffect} />
          ) : (
            <div className="event-detail-pending">
              {event.status === 'PENDING' || event.status === 'PROCESSING'
                ? 'Processing in background... Click refresh or wait for the worker tick to record the decision.'
                : 'No deception decision recorded for this event.'}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
};
