import React from 'react';
import { type DeceptionDecision } from '@false-route/contracts';
import { Badge, type BadgeVariant } from '../../components/Badge.js';

export interface DecisionCardProps {
  readonly decision: DeceptionDecision;
}

function getActionBadgeVariant(action: string): BadgeVariant {
  switch (action) {
    case 'ASSIGN_FALSE_ROUTE':
      return 'simulated';
    case 'ALERT_OPERATOR':
      return 'warning';
    case 'OBSERVE':
      return 'info';
    case 'ALLOW':
      return 'success';
    default:
      return 'neutral';
  }
}

export const DecisionCard: React.FC<DecisionCardProps> = ({ decision }) => {
  const enrichment = decision.modelEnrichment;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-md)' }}>
      {/* 1. Deterministic Deception Decision */}
      <div
        style={{
          padding: 'var(--space-unit-md)',
          backgroundColor: 'var(--surface-card-accent)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-unit-sm)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-size-xs)',
              fontWeight: 700,
              color: 'var(--text-secondary)',
            }}
          >
            DETERMINISTIC DECISION
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-unit-xs)' }}>
            <Badge variant="neutral">PROVENANCE: {decision.decisionProvenance}</Badge>
            <Badge variant="simulated">{decision.containmentMode}</Badge>
            <Badge variant={getActionBadgeVariant(decision.action)}>{decision.action}</Badge>
          </div>
        </div>

        {'assignedFalseRoute' in decision && decision.assignedFalseRoute && (
          <div
            style={{
              margin: 'var(--space-unit-sm) 0',
              padding: 'var(--space-unit-sm)',
              backgroundColor: 'var(--status-simulated-bg)',
              border: '1px solid var(--status-simulated-border)',
              borderRadius: 'var(--radius-input)',
            }}
          >
            <span style={{ fontSize: 'var(--text-size-xs)', color: 'var(--text-secondary)' }}>
              Assigned False Route Target:{' '}
            </span>
            <strong style={{ color: 'var(--status-simulated-text)' }}>
              {decision.assignedFalseRoute}
            </strong>
          </div>
        )}

        <div
          style={{
            fontSize: 'var(--text-size-sm)',
            color: 'var(--text-body)',
            marginTop: 'var(--space-unit-xs)',
          }}
        >
          <p>
            <strong>Reason:</strong> {decision.reason}
          </p>
          <p style={{ marginTop: 'var(--space-unit-xs)' }}>
            <strong>Matched Policy:</strong> <code>{decision.matchedPolicy}</code>
          </p>
        </div>

        {/* Audit Record Snapshot */}
        <div
          style={{
            marginTop: 'var(--space-unit-md)',
            paddingTop: 'var(--space-unit-sm)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 'var(--text-size-xs)',
            color: 'var(--text-muted)',
            flexWrap: 'wrap',
            gap: 'var(--space-unit-xs)',
          }}
        >
          <span>
            Audit Rule Version: <strong>{decision.auditRecord.ruleVersion}</strong>
          </span>
          <span>
            Evaluated At:{' '}
            <strong>{new Date(decision.auditRecord.evaluatedAt).toLocaleTimeString()}</strong>
          </span>
        </div>
      </div>

      {/* 2. Advisory Model Enrichment or Degraded Status */}
      {enrichment && (
        <div
          style={{
            padding: 'var(--space-unit-md)',
            backgroundColor: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-card)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 'var(--space-unit-sm)',
            }}
          >
            <span
              style={{
                fontSize: 'var(--text-size-xs)',
                fontWeight: 700,
                color: 'var(--text-secondary)',
              }}
            >
              GEMINI MODEL ENRICHMENT (ADVISORY ONLY)
            </span>
            <Badge variant={enrichment.provenance === 'INFERRED' ? 'info' : 'warning'}>
              PROVENANCE: {enrichment.provenance}
            </Badge>
          </div>

          {'summary' in enrichment ? (
            <div
              style={{
                fontSize: 'var(--text-size-sm)',
                color: 'var(--text-body)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-unit-xs)',
              }}
            >
              <p>
                <strong>Summary:</strong> {enrichment.summary}
              </p>
              <p>
                <strong>Explanation:</strong> {enrichment.explanation}
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-unit-md)',
                  marginTop: 'var(--space-unit-xs)',
                  fontSize: 'var(--text-size-xs)',
                  color: 'var(--text-secondary)',
                }}
              >
                <span>
                  Recommended Action: <strong>{enrichment.recommendedAction}</strong>
                </span>
                <span>
                  Confidence: <strong>{Math.round(enrichment.confidence * 100)}%</strong>
                </span>
                <span>
                  Model: <strong>{enrichment.modelIdentifier}</strong>
                </span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-size-sm)', color: 'var(--text-body)' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-unit-xs)',
                  marginBottom: 'var(--space-unit-xs)',
                }}
              >
                <Badge variant="danger">STATUS: {enrichment.status}</Badge>
              </div>
              <p style={{ color: 'var(--status-danger-text)' }}>{enrichment.reason}</p>
              <p
                style={{
                  fontSize: 'var(--text-size-xs)',
                  color: 'var(--text-muted)',
                  marginTop: 'var(--space-unit-xs)',
                }}
              >
                Deterministic safe policy engine operated independently of degraded model response.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
