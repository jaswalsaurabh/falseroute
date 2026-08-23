import React, { useState } from 'react';
import { Card } from '../../components/Card.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Badge } from '../../components/Badge.js';
import { type ApiClient } from '../../api/client.js';
import { type CreateIntrusionEventRequest } from '@false-route/contracts';

export interface EventSimulatorFormProps {
  readonly client: ApiClient;
  readonly onEventCreated: () => void;
}

export const EventSimulatorForm: React.FC<EventSimulatorFormProps> = ({
  client,
  onEventCreated,
}) => {
  const [scenario, setScenario] = useState<'decoy' | 'non-decoy' | 'brute-force'>('decoy');
  const [sourceIp, setSourceIp] = useState('198.51.100.45');
  const [failedAttempts, setFailedAttempts] = useState('3');
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleScenarioChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'decoy' | 'non-decoy' | 'brute-force';
    setScenario(val);
    if (val === 'decoy') {
      setSourceIp('198.51.100.45');
      setFailedAttempts('3');
    } else if (val === 'non-decoy') {
      setSourceIp('203.0.113.12');
      setFailedAttempts('1');
    } else {
      setSourceIp('192.0.2.99');
      setFailedAttempts('8');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const eventId = crypto.randomUUID();
      const correlationId = `corr-sim-${Date.now()}`;
      const occurredAt = new Date().toISOString();

      let payload: CreateIntrusionEventRequest;

      if (scenario === 'decoy') {
        payload = {
          id: eventId,
          occurredAt,
          correlationId,
          sourceIp: sourceIp.trim(),
          targetAsset: 'mock-admin-portal',
          eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
          failedLoginCount: Number(failedAttempts) || 3,
          riskIndicators: ['credential_stuffing_burst', 'decoy_credential_detected'],
          containmentMode: 'SIMULATED',
          usedDecoyCredential: true,
          decoyIdentifier: 'mock-admin-decoy-creds',
        };
      } else if (scenario === 'brute-force') {
        payload = {
          id: eventId,
          occurredAt,
          correlationId,
          sourceIp: sourceIp.trim(),
          targetAsset: 'mock-admin-portal',
          eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
          failedLoginCount: Number(failedAttempts) || 8,
          riskIndicators: ['rapid_retry_sequence', 'credential_burst'],
          containmentMode: 'SIMULATED',
          usedDecoyCredential: false,
        };
      } else {
        payload = {
          id: eventId,
          occurredAt,
          correlationId,
          sourceIp: sourceIp.trim(),
          targetAsset: 'mock-admin-portal',
          eventType: 'SUSPICIOUS_LOGIN',
          failedLoginCount: Number(failedAttempts) || 1,
          riskIndicators: ['unusual_login_time'],
          containmentMode: 'SIMULATED',
          usedDecoyCredential: false,
        };
      }

      const response = await client.createEvent(payload);
      setSuccessMessage(
        `Event accepted (ID: ${response.id.slice(0, 8)}...). Status: ${response.status}. Worker evaluating.`,
      );
      onEventCreated();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to submit simulated event.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card
      title="Intrusion Event Simulator"
      subtitle="Generate fictional intrusion signals to test autonomous policy evaluation and false-route containment."
      badge={<Badge variant="info">SIMULATOR</Badge>}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-md)' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-xs)' }}>
          <label
            htmlFor="scenario-select"
            style={{ fontSize: 'var(--text-size-sm)', fontWeight: 500 }}
          >
            Attack Scenario Preset
          </label>
          <select
            id="scenario-select"
            className="input-field"
            value={scenario}
            onChange={handleScenarioChange}
          >
            <option value="decoy">
              Decoy Credential Trigger (Triggers ASSIGN_FALSE_ROUTE to mock-admin-decoy)
            </option>
            <option value="non-decoy">Standard Access (Non-Decoy; triggers OBSERVE)</option>
            <option value="brute-force">
              High-Frequency Anomaly (Non-Decoy; triggers ALERT_OPERATOR)
            </option>
          </select>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-unit-md)',
          }}
        >
          <Input
            id="source-ip"
            label="Source IP Address"
            value={sourceIp}
            onChange={(e) => setSourceIp(e.target.value)}
            required
          />
          <Input
            id="failed-attempts"
            label="Failed Login Count"
            type="number"
            min="0"
            max="100"
            value={failedAttempts}
            onChange={(e) => setFailedAttempts(e.target.value)}
            required
          />
        </div>

        {scenario === 'decoy' && (
          <div
            style={{
              padding: 'var(--space-unit-sm) var(--space-unit-md)',
              backgroundColor: 'var(--status-simulated-bg)',
              border: '1px solid var(--status-simulated-border)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--text-size-xs)',
              color: 'var(--status-simulated-text)',
            }}
          >
            <strong>Trigger Active:</strong> Using fictional decoy credential{' '}
            <code>mock-admin-decoy-creds</code> on protected asset <code>mock-admin-portal</code>.
          </div>
        )}

        {successMessage && (
          <div
            style={{
              padding: 'var(--space-unit-sm) var(--space-unit-md)',
              backgroundColor: 'var(--status-success-bg)',
              border: '1px solid var(--status-success-border)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--text-size-xs)',
              color: 'var(--status-success-text)',
            }}
          >
            {successMessage}
          </div>
        )}

        {errorMessage && (
          <div
            style={{
              padding: 'var(--space-unit-sm) var(--space-unit-md)',
              backgroundColor: 'var(--status-danger-bg)',
              border: '1px solid var(--status-danger-border)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--text-size-xs)',
              color: 'var(--status-danger-text)',
            }}
          >
            {errorMessage}
          </div>
        )}

        <div
          style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-unit-sm)' }}
        >
          <Button type="submit" variant="primary" isLoading={isLoading}>
            Transmit Simulated Event
          </Button>
        </div>
      </form>
    </Card>
  );
};
