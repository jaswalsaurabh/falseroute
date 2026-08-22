import React from 'react';
import { Ban, CloudCog, LockKeyhole } from 'lucide-react';
import { Badge } from '../../components/Badge.js';
import { IconBadge } from '../../components/IconBadge.js';
export const ActiveResourcesPanel: React.FC = () => (
  <section className="pane pane-containment" aria-labelledby="active-resources-heading">
    <div className="pane-header">
      <div className="pane-title">
        <IconBadge tone="success">
          <LockKeyhole size={17} />
        </IconBadge>
        <div>
          <h2 id="active-resources-heading">
            Containment <span className="sr-only">3. Active Deception &amp; Quarantine State</span>
          </h2>
          <p>Owned decoys, routes, and TTL leases</p>
        </div>
      </div>
      <Badge variant="warning">Unavailable</Badge>
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
        <Badge variant="warning">Unavailable</Badge>
        <span className="sr-only">Unavailable in this deployment.</span>
        <p>Authoritative lease-backed resource state is not exposed by the current API.</p>
      </div>
    </div>
    <div className="resource-section">
      <h3>
        <Ban size={14} /> Cloud Armor quarantine leases
      </h3>
      <div className="unavailable-card">
        <Badge variant="neutral">No inferred state</Badge>
        <p>
          Historical activity is not used to claim an active quarantine or route.{' '}
          <span className="sr-only">These are historical audit records.</span>
        </p>
      </div>
    </div>
  </section>
);
