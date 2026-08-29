import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScenarioInjector } from './simulator/ScenarioInjector.js';
import { WorkflowTimeline } from './orchestration/WorkflowTimeline.js';
import { ActiveResourcesPanel } from './active-responses/ActiveResourcesPanel.js';
import { type ApiClient } from '../api/client.js';
import { type ActivityEvent } from '@false-route/contracts';
import { AutonomousIntelligencePanel } from './intelligence/AutonomousIntelligencePanel.js';

describe('Autonomous Console Components', () => {
  it('ScenarioInjector sends strict evidence and reports configured transport acceptance', async () => {
    const mockClient = {
      createAutonomousScenario: vi.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-scenario-test',
        status: 'PENDING',
        message: 'Autonomous scenario accepted and delivered for evaluation',
        receivedAt: '2026-08-22T10:00:00.000Z',
      }),
    } as unknown as ApiClient;

    render(<ScenarioInjector client={mockClient} />);

    expect(screen.getByText('1. Autonomous Scenario Injector')).toBeDefined();
    expect(screen.getByRole('combobox', { name: /Select synthetic scenario/i })).toBeDefined();
    expect(screen.getByRole('link', { name: 'View all events' })).toBeDefined();

    // Switch scenario to WordPress probe
    fireEvent.change(screen.getByRole('combobox', { name: /Select synthetic scenario/i }), {
      target: { value: 'WORDPRESS_CONFIG_PROBE' },
    });
    expect(screen.getAllByText(/WordPress/i).length).toBeGreaterThanOrEqual(1);

    // Click submit
    const submitBtn = screen.getByRole('button', { name: 'Inject Attack Scenario' });
    fireEvent.click(submitBtn);

    expect(mockClient.createAutonomousScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioKind: 'WORDPRESS_CONFIG_PROBE',
        sourceIp: '198.51.100.26',
        evidence: expect.objectContaining({
          scenarioKind: 'WORDPRESS_CONFIG_PROBE',
          sourceIp: '198.51.100.26',
        }),
      }),
    );
    await waitFor(() => expect(mockClient.createAutonomousScenario).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/Autonomous scenario accepted and delivered for evaluation/),
    ).toBeNull();
  });

  it('WorkflowTimeline renders live SSE events with correct truthful badges', () => {
    const mockEvents: ActivityEvent[] = [
      {
        cursor: 1,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'RECEIVED',
        eventType: 'INTRUSION_INGESTED',
        summary: 'Ingested ENV_FILE_PROBE from 198.51.100.25',
        provenance: 'OBSERVED',
        occurredAt: '2026-08-22T10:00:00.000Z',
      },
      {
        cursor: 2,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'REQUESTED',
        eventType: 'MODEL_TOOL_REQUESTED',
        summary: 'Model requested tool: request_decoy_deployment',
        provenance: 'INFERRED',
        occurredAt: '2026-08-22T10:00:01.000Z',
      },
      {
        cursor: 3,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'AUTHORIZED',
        eventType: 'TOOL_AUTHORIZED',
        summary: 'Deterministic policy authorized request_decoy_deployment',
        provenance: 'DERIVED',
        occurredAt: '2026-08-22T10:00:02.000Z',
      },
      {
        cursor: 4,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'NARROWED',
        eventType: 'TOOL_NARROWED',
        summary: 'Deterministic policy narrowed request_decoy_deployment',
        provenance: 'DERIVED',
        occurredAt: '2026-08-22T10:00:02.500Z',
      },
      {
        cursor: 5,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'REJECTED',
        eventType: 'TOOL_REJECTED',
        summary: 'Deterministic policy rejected request_source_quarantine',
        provenance: 'DERIVED',
        occurredAt: '2026-08-22T10:00:03.000Z',
      },
      {
        cursor: 6,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'FAKE_EXECUTED',
        eventType: 'TOOL_EXECUTED',
        summary: 'Simulated action executed for request_decoy_deployment',
        provenance: 'DERIVED',
        occurredAt: '2026-08-22T10:00:04.000Z',
      },
      {
        cursor: 7,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'ENRICHED',
        eventType: 'GEMINI_ANALYSIS_DEGRADED',
        summary: 'Gemini analysis degraded (TIMEOUT): Service timed out',
        provenance: 'UNAVAILABLE',
        occurredAt: '2026-08-22T10:00:05.000Z',
      },
      {
        cursor: 8,
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-1',
        stage: 'EXECUTED',
        eventType: 'TOOL_EXECUTED',
        summary: 'Provider action executed successfully',
        provenance: 'OBSERVED',
        occurredAt: '2026-08-22T10:00:06.000Z',
      },
    ];

    render(<WorkflowTimeline events={mockEvents} streamStatus="CONNECTED" />);

    expect(screen.getByText('2. Autonomous Execution Timeline')).toBeDefined();
    expect(screen.getByText('LIVE SSE STREAM')).toBeDefined();
    expect(screen.getAllByText('RECEIVED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('REQUESTED (AI)')).toBeDefined();
    expect(screen.getByText('POLICY AUTHORIZED')).toBeDefined();
    expect(screen.getByText('POLICY NARROWED')).toBeDefined();
    expect(screen.getByText('POLICY REJECTED')).toBeDefined();
    expect(screen.getByText(/fake executed/i)).toBeDefined();
    expect(screen.getByText('AI DEGRADED')).toBeDefined();
    expect(screen.getByRole('img', { name: 'POLICY AUTHORIZED' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'POLICY NARROWED' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'FAKE EXECUTED' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'EXECUTED' })).toBeDefined();
    expect(screen.getAllByRole('img', { name: 'observed' }).length).toBeGreaterThan(0);
  });

  it('WorkflowTimeline progressively reveals long terminal logs', () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      cursor: index + 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-long-log',
      stage: 'RECEIVED' as const,
      eventType: 'INTRUSION_INGESTED' as const,
      summary: `Trace entry ${index + 1}`,
      provenance: 'OBSERVED' as const,
      occurredAt: '2026-08-22T10:00:00.000Z',
    }));

    render(<WorkflowTimeline events={events} streamStatus="CONNECTED" />);

    const logRegion = screen.getByRole('region', { name: 'Execution trace log' });
    expect(logRegion).toBeDefined();
    expect(screen.queryByText('Trace entry 10')).toBeNull();

    fireEvent.scroll(logRegion);
    expect(screen.getByText('Trace entry 10')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Load more logs/ })).toBeNull();
  });

  it('ActiveResourcesPanel does not infer active resources from activity history', () => {
    render(<ActiveResourcesPanel />);

    expect(screen.getByText('3. Active Deception & Quarantine State')).toBeDefined();
    expect(screen.getByText('Unavailable in this deployment.')).toBeDefined();
    expect(screen.getByText(/historical audit records/)).toBeDefined();
    expect(screen.queryByText(/HEALTHY/)).toBeNull();
  });

  it('keeps assessment, decision ownership, and campaign state unavailable without authoritative payloads', () => {
    render(<AutonomousIntelligencePanel activityEvents={[]} />);

    expect(screen.getByRole('heading', { name: 'Decision intelligence' })).toBeDefined();
    expect(screen.getByText(/No model output is inferred/)).toBeDefined();
    expect(screen.getByText(/No authoritative campaign payload is loaded/)).toBeDefined();
    expect(screen.getByText(/fake executed/i)).toBeDefined();
  });

  it('renders contract-backed assessment, action origins, and campaign progress', () => {
    render(
      <AutonomousIntelligencePanel
        activityEvents={[]}
        context={{
          contextSchemaVersion: '1.0.0',
          currentEventId: '11111111-1111-4111-8111-111111111111',
          correlationId: 'corr-ai-7',
          scenarioKind: 'ENV_FILE_PROBE',
          syntheticSource: '198.51.100.25',
          signals: [
            {
              signalId: 'signal-1',
              scenarioKind: 'ENV_FILE_PROBE',
              summary: 'Synthetic probe',
              observedAt: '2026-08-22T10:00:00.000Z',
              evidenceRefs: ['evidence-1'],
            },
          ],
          evidence: [
            {
              evidenceId: 'evidence-1',
              evidenceType: 'HTTP_REQUEST',
              observedAt: '2026-08-22T10:00:00.000Z',
              provenance: 'OBSERVED',
            },
          ],
          priorPolicyOutcomes: [
            {
              action: 'ASSIGN_FALSE_ROUTE',
              outcome: 'AUTHORIZED',
              origin: 'MODEL_REQUEST',
              evaluatedAt: '2026-08-22T10:00:01.000Z',
            },
          ],
          activeLeases: [],
          contextCompleteness: 'COMPLETE',
        }}
        assessment={{
          incidentStage: 'RECONNAISSANCE',
          riskTier: 'HIGH',
          confidence: 0.82,
          hypothesis: 'The probe is mapping a synthetic configuration surface.',
          evidenceRefs: ['evidence-1'],
          recommendedActions: ['ASSIGN_FALSE_ROUTE'],
          rationale: 'The observed request matches the bounded scenario evidence.',
          needsFollowUp: true,
        }}
        campaign={{
          campaignId: '11111111-1111-4111-8111-111111111111',
          definitionId: 'INITIAL_AUTONOMOUS_CAMPAIGN',
          definitionVersion: '1.0.0',
          status: 'RUNNING',
          currentStep: 2,
          totalSteps: 4,
          correlationId: 'corr-ai-7',
          startedAt: '2026-08-22T10:00:00.000Z',
        }}
      />,
    );

    expect(
      screen.getByText('The probe is mapping a synthetic configuration surface.'),
    ).toBeDefined();
    expect(screen.getByText('Model request')).toBeDefined();
    expect(screen.getByLabelText('Evidence refs: evidence-1')).toBeDefined();
    expect(screen.getByText('Step 2 of 4')).toBeDefined();
    expect(screen.getByLabelText('2 of 4 campaign steps complete')).toBeDefined();
  });
});
