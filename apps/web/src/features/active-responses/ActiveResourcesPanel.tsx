import React from 'react';
import { Ban, CloudCog, Minus, TriangleAlert } from 'lucide-react';
import { IconBadge } from '../../components/IconBadge.js';
export const ActiveResourcesPanel: React.FC = () => (
  <section className="pane pane-containment" aria-labelledby="active-resources-heading">
    <div className="pane-header">
      <div>
        <h2 id="active-resources-heading">
          <span className="pane-step">03</span>Containment
          <span className="sr-only">3. Active Deception &amp; Quarantine State</span>
        </h2>
        <p>Owned decoys, routes, and TTL leases</p>
      </div>
      <IconBadge tone="warning" label="Unavailable" tooltip="Unavailable">
        <TriangleAlert size={13} aria-hidden="true" />
      </IconBadge>
    </div>
    <div className="containment-stats">
      <div>
        <strong>—</strong>
        <span>Live decoys</span>
      </div>
      <div>
        <strong>—</strong>
        <span>Quarantined</span>
      </div>
      <div>
        <strong>—</strong>
        <span>False routes</span>
      </div>
    </div>
    <div className="resource-section">
      <h3>
        <CloudCog size={14} /> Cloud Run decoys
      </h3>
      <div className="unavailable-card">
        <IconBadge tone="warning" label="Unavailable" tooltip="Unavailable">
          <TriangleAlert size={13} aria-hidden="true" />
        </IconBadge>
        <span className="sr-only">Unavailable in this deployment.</span>
        <p>Authoritative lease-backed resource state is not exposed by the current API.</p>
      </div>
    </div>
    <div className="resource-section">
      <h3>
        <Ban size={14} /> Cloud Armor quarantine leases
      </h3>
      <div className="unavailable-card">
        <IconBadge tone="neutral" label="No inferred state" tooltip="No inferred state">
          <Minus size={13} aria-hidden="true" />
        </IconBadge>
        <p>
          Historical activity is not used to claim an active quarantine or route.{' '}
          <span className="sr-only">These are historical audit records.</span>
        </p>
      </div>
    </div>
  </section>
);
