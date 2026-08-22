import React from 'react';

export const ActiveResourcesPanel: React.FC = () => {
  return (
    <section className="card" aria-labelledby="active-resources-heading">
      <h2
        id="active-resources-heading"
        style={{ fontSize: 'var(--text-size-lg)', marginBottom: 'var(--space-unit-xs)' }}
      >
        3. Active Deception & Quarantine State
      </h2>
      <div
        role="status"
        style={{
          padding: 'var(--space-unit-md)',
          backgroundColor: 'var(--surface-input)',
          borderRadius: 'var(--radius-card)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-size-sm)',
        }}
      >
        <strong>Unavailable in this deployment.</strong>
        <p style={{ marginTop: 'var(--space-unit-xs)' }}>
          Active resource state requires an authoritative lease-backed API. Timeline events are
          historical audit records and are not used to infer whether a decoy, route, or quarantine
          is currently active.
        </p>
      </div>
    </section>
  );
};
