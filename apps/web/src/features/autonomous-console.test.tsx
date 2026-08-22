import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ScenarioInjector } from './simulator/ScenarioInjector.js';
import { WorkflowTimeline } from './orchestration/WorkflowTimeline.js';
import { ActiveResourcesPanel } from './active-responses/ActiveResourcesPanel.js';
import { type ApiClient } from '../api/client.js';
import { type ActivityEvent } from '@false-route/contracts';

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
    const select = screen.getByLabelText('Attack Scenario Pattern') as HTMLSelectElement;
    expect(select.options.length).toBe(7);

    // Switch scenario to WordPress probe
    fireEvent.change(select, { target: { value: 'WORDPRESS_CONFIG_PROBE' } });
    expect(screen.getAllByText(/WordPress/i).length).toBeGreaterThanOrEqual(1);

    // Click submit
    const submitBtn = screen.getByRole('button', { name: 'Inject Attack Scenario' });
    fireEvent.click(submitBtn);

    expect(mockClient.createAutonomousScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioKind: 'WORDPRESS_CONFIG_PROBE',
        sourceIp: '198.51.100.25',
        evidence: expect.objectContaining({
          scenarioKind: 'WORDPRESS_CONFIG_PROBE',
          sourceIp: '198.51.100.25',
        }),
      }),
    );
    expect(
      await screen.findByText(/Autonomous scenario accepted and delivered for evaluation/),
    ).toBeDefined();
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
    ];

    render(<WorkflowTimeline events={mockEvents} streamStatus="CONNECTED" />);

    expect(screen.getByText('2. Autonomous Execution Timeline')).toBeDefined();
    expect(screen.getByText('LIVE SSE STREAM')).toBeDefined();
    expect(screen.getByText('RECEIVED')).toBeDefined();
    expect(screen.getByText('REQUESTED (AI)')).toBeDefined();
    expect(screen.getByText('POLICY AUTHORIZED')).toBeDefined();
    expect(screen.getByText('POLICY NARROWED')).toBeDefined();
    expect(screen.getByText('POLICY REJECTED')).toBeDefined();
    expect(screen.getByText('FAKE EXECUTED')).toBeDefined();
    expect(screen.getByText('AI DEGRADED')).toBeDefined();
  });

  it('ActiveResourcesPanel does not infer active resources from activity history', () => {
    render(<ActiveResourcesPanel />);

    expect(screen.getByText('3. Active Deception & Quarantine State')).toBeDefined();
    expect(screen.getByText('Unavailable in this deployment.')).toBeDefined();
    expect(screen.getByText(/historical audit records/)).toBeDefined();
    expect(screen.queryByText(/HEALTHY/)).toBeNull();
  });
});
