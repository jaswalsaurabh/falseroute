import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { App } from './App.js';
import { DecisionCard } from './features/events/DecisionCard.js';
import { type IntrusionEvent, type DeceptionDecision } from '@false-route/contracts';

describe('Web Dashboard Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders controlled demonstration unlock screen by default', () => {
    render(<App />);
    expect(screen.getByText('Controlled Demonstration Unlock')).toBeDefined();
    expect(screen.getByLabelText('Operator Access Token')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Unlock Dashboard' })).toBeDefined();
  });

  it('unlocks dashboard when valid operator access token is submitted', async () => {
    // Mock global fetch for readiness check and event listing
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/v1/ready')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: 'ready',
              database: 'connected',
              timestamp: new Date().toISOString(),
            }),
        });
      }
      if (url.includes('/api/v1/intrusion-events')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              events: [],
              total: 0,
              limit: 50,
              offset: 0,
            }),
        });
      }
      return Promise.reject(new Error(`Unhandled fetch url: ${url}`));
    });

    render(<App />);

    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: 'demo-secret-token-123' } });

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    await waitFor(() => {
      expect(screen.getByText('Intrusion Event Simulator')).toBeDefined();
      expect(screen.getByText('Intrusion Events Feed')).toBeDefined();
    });

    // Ensure raw secret token is NOT exposed anywhere in DOM text
    expect(screen.queryByText('demo-secret-token-123')).toBeNull();
  });

  it('renders deterministic ASSIGN_FALSE_ROUTE decision with SIMULATED badges and truthful simulated effect evidence', () => {
    const mockDecision: DeceptionDecision = {
      id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      correlationId: 'corr-test-001',
      action: 'ASSIGN_FALSE_ROUTE',
      assignedFalseRoute: 'mock-admin-decoy',
      matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
      reason: 'Decoy credential trigger matched.',
      containmentMode: 'SIMULATED',
      decisionProvenance: 'DERIVED',
      decidedAt: '2026-08-22T00:00:00.000Z',
      auditRecord: {
        ruleVersion: '2026.08.1',
        evaluatedAt: '2026-08-22T00:00:00.000Z',
      },
    };

    const mockSimulatedEffect = {
      id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
      decisionId: mockDecision.id,
      correlationId: mockDecision.correlationId,
      effectKind: 'ASSIGN_FALSE_ROUTE' as const,
      status: 'RECORDED' as const,
      containmentMode: 'SIMULATED' as const,
      assignedFalseRoute: 'mock-admin-decoy' as const,
      provenance: 'DERIVED' as const,
      recordedAt: '2026-08-22T00:00:01.000Z',
      adapterVersion: 'simulated-deception-agent-v1',
    };

    const { container } = render(
      <DecisionCard decision={mockDecision} simulatedEffect={mockSimulatedEffect} />,
    );

    // Required truthful wording
    expect(screen.getByText('ASSIGN_FALSE_ROUTE')).toBeDefined();
    expect(screen.getAllByText('mock-admin-decoy').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);
    expect(screen.getByText('Simulated assignment recorded')).toBeDefined();
    expect(screen.getByText('RECORDED')).toBeDefined();
    expect(
      screen.getByText(
        'No real traffic or infrastructure change occurred. Simulated agent effect recorded to audit ledger.',
      ),
    ).toBeDefined();

    // Prohibited misleading claims strictly absent
    const renderedText = container.textContent ?? '';
    expect(renderedText).not.toContain('Executed');
    expect(renderedText).not.toContain('Redirect succeeded');
    expect(renderedText).not.toContain('Attacker contained');
    expect(renderedText).not.toContain('Traffic redirected');
  });

  it('renders degraded Gemini model result honestly', () => {
    const mockDegradedDecision: DeceptionDecision = {
      id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      correlationId: 'corr-test-001',
      action: 'ASSIGN_FALSE_ROUTE',
      assignedFalseRoute: 'mock-admin-decoy',
      matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
      reason: 'Decoy credential trigger matched.',
      containmentMode: 'SIMULATED',
      decisionProvenance: 'DERIVED',
      decidedAt: '2026-08-22T00:00:00.000Z',
      modelEnrichment: {
        correlationId: 'corr-test-001',
        status: 'TIMEOUT',
        reason: 'Gemini request timed out after 5000ms',
        provenance: 'UNAVAILABLE',
        evaluatedAt: '2026-08-22T00:00:00.000Z',
      },
      auditRecord: {
        ruleVersion: '2026.08.1',
        evaluatedAt: '2026-08-22T00:00:00.000Z',
      },
    };

    render(<DecisionCard decision={mockDegradedDecision} />);

    expect(screen.getByText('STATUS: TIMEOUT')).toBeDefined();
    expect(screen.getByText('Gemini request timed out after 5000ms')).toBeDefined();
    expect(screen.getByText('PROVENANCE: UNAVAILABLE')).toBeDefined();
  });

  it('refreshes open event detail modal when a pending event transitions to decided on refresh', async () => {
    const pendingEvent: IntrusionEvent = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      occurredAt: '2026-08-22T00:00:00.000Z',
      receivedAt: '2026-08-22T00:00:01.000Z',
      correlationId: 'corr-modal-refresh-001',
      sourceIp: '192.168.1.55',
      targetAsset: 'mock-admin-portal',
      eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
      failedLoginCount: 2,
      riskIndicators: ['SUSPICIOUS_UA'],
      containmentMode: 'SIMULATED',
      usedDecoyCredential: true,
      decoyIdentifier: 'mock-admin-decoy-creds',
      status: 'PENDING',
      provenance: 'OBSERVED',
    };

    const decidedEvent: IntrusionEvent = {
      ...pendingEvent,
      status: 'DECIDED',
    };

    const mockDecision: DeceptionDecision = {
      id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      eventId: pendingEvent.id,
      correlationId: pendingEvent.correlationId,
      action: 'ASSIGN_FALSE_ROUTE',
      assignedFalseRoute: 'mock-admin-decoy',
      matchedPolicy: 'DECOY_CREDENTIAL_TRIGGER',
      reason: 'Decoy credential trigger matched.',
      containmentMode: 'SIMULATED',
      decisionProvenance: 'DERIVED',
      decidedAt: '2026-08-22T00:00:02.000Z',
      auditRecord: {
        ruleVersion: '2026.08.1',
        evaluatedAt: '2026-08-22T00:00:02.000Z',
      },
    };

    let eventStatus: 'PENDING' | 'DECIDED' = 'PENDING';

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/v1/ready')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: 'ready',
              database: 'connected',
              timestamp: new Date().toISOString(),
            }),
        });
      }
      if (url.endsWith(`/api/v1/intrusion-events/${pendingEvent.id}`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              event: eventStatus === 'PENDING' ? pendingEvent : decidedEvent,
              decision: eventStatus === 'PENDING' ? null : mockDecision,
            }),
        });
      }
      if (url.includes('/api/v1/intrusion-events')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              events: [eventStatus === 'PENDING' ? pendingEvent : decidedEvent],
              total: 1,
              limit: 50,
              offset: 0,
            }),
        });
      }
      return Promise.reject(new Error(`Unhandled fetch url: ${url}`));
    });

    render(<App />);

    // Unlock dashboard
    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: 'demo-secret-token-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Dashboard' }));

    // Wait for events table to load with pending event
    await waitFor(() => {
      expect(screen.getByText('Intrusion Events Feed')).toBeDefined();
      expect(screen.getByText('PENDING')).toBeDefined();
    });

    // Inspect the pending event
    const inspectButton = screen.getByRole('button', { name: 'Inspect' });
    fireEvent.click(inspectButton);

    // Verify modal is open showing pending status and waiting message
    await waitFor(() => {
      expect(
        screen.getByText(
          'Processing in background... Click refresh or wait for the worker tick to record the decision.',
        ),
      ).toBeDefined();
    });

    // Simulate backend worker transition to DECIDED
    eventStatus = 'DECIDED';

    // Trigger refresh
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);

    // Verify modal automatically re-renders with the decision card
    await waitFor(() => {
      expect(screen.getByText('ASSIGN_FALSE_ROUTE')).toBeDefined();
      expect(screen.getAllByText('mock-admin-decoy').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Simulated assignment recorded')).toBeDefined();
      expect(
        screen.queryByText(
          'Processing in background... Click refresh or wait for the worker tick to record the decision.',
        ),
      ).toBeNull();
    });
  });
});
