import React, { useState } from 'react';
import { Card } from '../../components/Card.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Badge } from '../../components/Badge.js';
import { ApiClient, ApiError } from '../../api/client.js';

export interface UnlockScreenProps {
  readonly onUnlock: (token: string) => void;
}

export const UnlockScreen: React.FC<UnlockScreenProps> = ({ onUnlock }) => {
  const [tokenInput, setTokenInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) {
      setErrorMessage('Please enter the operator access token.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      // Validate candidate token and system readiness against API server
      const client = new ApiClient(tokenInput.trim());
      await client.validateCredentials();
      onUnlock(tokenInput.trim());
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'UNAUTHORIZED') {
          setErrorMessage('Invalid operator access token. Please check your credentials.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to connect to FalseRoute API server.',
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '480px', margin: '40px auto 0 auto' }}>
      <Card
        title="Controlled Demonstration Unlock"
        badge={<Badge variant="simulated">SIMULATED MODE</Badge>}
      >
        <p
          style={{
            fontSize: 'var(--text-size-sm)',
            color: 'var(--text-secondary)',
            marginBottom: 'var(--space-unit-lg)',
          }}
        >
          Enter the operator access token configured on the FalseRoute control-plane API to unlock
          the deception dashboard.
        </p>

        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-unit-md)' }}
        >
          <Input
            id="operator-token"
            label="Operator Access Token"
            type="password"
            placeholder="Enter token..."
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            error={errorMessage ?? undefined}
            helperText="Token remains in browser memory only and is never stored persistently."
            autoFocus
          />

          <Button
            type="submit"
            variant="primary"
            isLoading={isLoading}
            style={{ marginTop: 'var(--space-unit-sm)' }}
          >
            Unlock Dashboard
          </Button>
        </form>

        <div
          style={{
            marginTop: 'var(--space-unit-lg)',
            padding: 'var(--space-unit-sm) var(--space-unit-md)',
            backgroundColor: 'var(--surface-card-accent)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--text-size-xs)',
            color: 'var(--text-muted)',
          }}
        >
          <strong>Notice:</strong> This is a controlled demonstration of autonomous cyber deception.
          All traffic, assets, credentials, and actions are strictly simulated.
        </div>
      </Card>
    </div>
  );
};
