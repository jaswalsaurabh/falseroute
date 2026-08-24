import React from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, Eye, Sparkles } from 'lucide-react';
import type {
  ActionOrigin,
  ActivityEvent,
  CampaignRun,
  IncidentAssessment,
  IncidentContext,
} from '@false-route/contracts';
import { Badge, type BadgeVariant } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';

export interface AutonomousIntelligencePanelProps {
  readonly activityEvents: readonly ActivityEvent[];
  readonly context?: IncidentContext | null;
  readonly assessment?: IncidentAssessment | null;
  readonly campaign?: CampaignRun | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onStartCampaign?: (() => void) | undefined;
  readonly campaignStarting?: boolean | undefined;
  readonly campaignError?: string | null | undefined;
}

const provenanceVariant = (provenance: string): BadgeVariant =>
  provenance === 'OBSERVED'
    ? 'observed'
    : provenance === 'INFERRED'
      ? 'inferred'
      : provenance === 'DERIVED'
        ? 'derived'
        : 'warning';

const originLabel: Record<ActionOrigin, string> = {
  MODEL_REQUEST: 'Model request',
  MANDATORY_RULE: 'Mandatory rule',
  POLICY_FALLBACK: 'Policy fallback',
  DEGRADED_FALLBACK: 'Degraded fallback',
};

const actionLabel = (action: string) => action.replaceAll('_', ' ');

export const AutonomousIntelligencePanel: React.FC<AutonomousIntelligencePanelProps> = ({
  activityEvents,
  context,
  assessment,
  campaign,
  loading = false,
  error = null,
  onStartCampaign,
  campaignStarting = false,
  campaignError = null,
}) => {
  const latestActivity = activityEvents[0];
  const hasDegradedActivity = activityEvents.some(
    (event) => event.provenance === 'UNAVAILABLE' || event.eventType === 'GEMINI_ANALYSIS_DEGRADED',
  );
  const state = loading
    ? 'loading'
    : error
      ? 'failure'
      : hasDegradedActivity
        ? 'degraded'
        : 'ready';
  const comparison = assessment
    ? assessment.recommendedActions.map((action) => {
        const outcome = context?.priorPolicyOutcomes.find((item) => item.action === action);
        return { action, outcome };
      })
    : [];
  const campaignPercent = campaign
    ? Math.round((campaign.currentStep / campaign.totalSteps) * 100)
    : 0;

  return (
    <section className="intelligence-shell" aria-labelledby="intelligence-heading">
      <div className="intelligence-heading">
        <div>
          <span className="section-kicker">
            <Sparkles size={14} aria-hidden="true" /> AI-7 operator intelligence
          </span>
          <h2 id="intelligence-heading">Assessment &amp; decision comparison</h2>
          <p>Model interpretation is shown separately from deterministic policy ownership.</p>
        </div>
        <Badge variant={state === 'degraded' || state === 'failure' ? 'warning' : 'neutral'}>
          {state === 'ready' ? 'READY TO INSPECT' : state.toUpperCase()}
        </Badge>
      </div>

      {state === 'loading' ? (
        <div className="intelligence-state" role="status">
          <Clock3 size={18} aria-hidden="true" /> Loading intelligence evidence…
        </div>
      ) : state === 'failure' ? (
        <div className="intelligence-state intelligence-state-danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" /> {error}
        </div>
      ) : (
        <div className="intelligence-grid">
          <article className="intelligence-card" aria-labelledby="assessment-heading">
            <div className="intelligence-card-heading">
              <div>
                <span className="section-kicker">
                  <Eye size={13} aria-hidden="true" /> Assessment
                </span>
                <h3 id="assessment-heading">What the evidence suggests</h3>
              </div>
              <Badge variant={assessment ? provenanceVariant('INFERRED') : 'warning'}>
                {assessment ? 'INFERRED' : 'UNAVAILABLE'}
              </Badge>
            </div>
            {assessment ? (
              <>
                <div className="intelligence-facts">
                  <div>
                    <span>Stage</span>
                    <strong>{actionLabel(assessment.incidentStage)}</strong>
                  </div>
                  <div>
                    <span>Risk</span>
                    <strong>{assessment.riskTier}</strong>
                  </div>
                  <div>
                    <span>Confidence</span>
                    <strong>{Math.round(assessment.confidence * 100)}%</strong>
                  </div>
                </div>
                <p className="intelligence-hypothesis">{assessment.hypothesis}</p>
                <p className="intelligence-detail">
                  <strong>Rationale:</strong> {assessment.rationale}
                </p>
                <div className="intelligence-meta">
                  <Badge variant="inferred">
                    Evidence refs: {assessment.evidenceRefs.join(', ')}
                  </Badge>
                  {context && (
                    <Badge
                      variant={provenanceVariant(
                        context.contextCompleteness === 'COMPLETE' ? 'DERIVED' : 'UNAVAILABLE',
                      )}
                    >
                      {context.contextCompleteness} context
                    </Badge>
                  )}
                </div>
              </>
            ) : (
              <div className="intelligence-empty">
                <CircleHelp size={18} aria-hidden="true" />
                <span>
                  Assessment unavailable. No model output is inferred from the activity stream.
                </span>
              </div>
            )}
          </article>

          <article className="intelligence-card" aria-labelledby="comparison-heading">
            <div className="intelligence-card-heading">
              <div>
                <span className="section-kicker">
                  <CheckCircle2 size={13} aria-hidden="true" /> Decision ownership
                </span>
                <h3 id="comparison-heading">Recommendation vs policy</h3>
              </div>
              <Badge variant="derived">DERIVED VIEW</Badge>
            </div>
            {comparison.length > 0 ? (
              <div
                className="decision-comparison"
                role="table"
                aria-label="Model recommendation and policy outcome"
              >
                <div className="decision-comparison-row decision-comparison-header" role="row">
                  <span role="columnheader">Action</span>
                  <span role="columnheader">Policy outcome</span>
                  <span role="columnheader">Origin</span>
                </div>
                {comparison.map(({ action, outcome }) => (
                  <div className="decision-comparison-row" role="row" key={action}>
                    <strong role="cell">{actionLabel(action)}</strong>
                    <span role="cell">{outcome ? outcome.outcome : 'Not available'}</span>
                    <Badge variant={outcome?.origin === 'MODEL_REQUEST' ? 'inferred' : 'derived'}>
                      {outcome ? originLabel[outcome.origin] : 'Unavailable'}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="intelligence-empty">
                <CircleHelp size={18} aria-hidden="true" />
                <span>
                  Decision comparison unavailable until an assessment and policy outcome are
                  returned.
                </span>
              </div>
            )}
            <p className="intelligence-footnote">
              Mandatory actions and deterministic fallbacks remain policy-owned. “Fake executed”
              means a recorded simulation, not a real infrastructure change.
            </p>
          </article>

          <article
            className="intelligence-card intelligence-card-wide"
            aria-labelledby="campaign-heading"
          >
            <div className="intelligence-card-heading">
              <div>
                <span className="section-kicker">
                  <Clock3 size={13} aria-hidden="true" /> Campaign
                </span>
                <h3 id="campaign-heading">Autonomous campaign progress</h3>
              </div>
              <Badge
                variant={
                  campaign ? (campaign.status === 'FAILED' ? 'danger' : 'simulated') : 'warning'
                }
              >
                {campaign ? campaign.status : 'UNAVAILABLE'}
              </Badge>
            </div>
            {campaign ? (
              <>
                <div
                  className="campaign-progress"
                  aria-label={`${campaign.currentStep} of ${campaign.totalSteps} campaign steps complete`}
                >
                  <span style={{ width: `${campaignPercent}%` }} />
                </div>
                <div className="campaign-summary">
                  <strong>
                    Step {campaign.currentStep} of {campaign.totalSteps}
                  </strong>
                  <span>
                    {campaignPercent}% recorded progress · definition {campaign.definitionVersion}
                  </span>
                </div>
                <p className="intelligence-footnote">
                  Campaign state is contract-backed. Effects remain simulated/recorded in this
                  console.
                </p>
              </>
            ) : (
              <div className="intelligence-empty">
                <CircleHelp size={18} aria-hidden="true" />
                <span>
                  No authoritative campaign payload is loaded. Activity history alone does not
                  establish campaign progress.
                </span>
                {onStartCampaign && (
                  <Button type="button" onClick={onStartCampaign} disabled={campaignStarting}>
                    {campaignStarting ? 'Starting campaign…' : 'Start autonomous campaign'}
                  </Button>
                )}
                {campaignError && (
                  <span role="alert" className="intelligence-degraded">
                    {campaignError}
                  </span>
                )}
              </div>
            )}
          </article>
        </div>
      )}
      {state === 'degraded' && (
        <p className="intelligence-degraded" role="status">
          <AlertTriangle size={14} aria-hidden="true" /> Some intelligence evidence is unavailable
          or degraded. Review observed activity and policy records.
        </p>
      )}
      {!loading && !error && latestActivity && (
        <p className="intelligence-source">
          Latest stream record: <code>{latestActivity.eventType}</code> · provenance{' '}
          {latestActivity.provenance.toLowerCase()}
        </p>
      )}
    </section>
  );
};
