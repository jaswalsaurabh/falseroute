import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UnlockScreen } from './UnlockScreen.js';

describe('UnlockScreen', () => {
  const syntheticToken = 'not-a-real-local-operator-token';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validates empty token input and shows an error message without calling onUnlock', async () => {
    const mockOnUnlock = vi.fn();
    globalThis.fetch = vi.fn();

    render(<UnlockScreen onUnlock={mockOnUnlock} />);

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    expect(screen.getByText('Please enter the operator access token.')).toBeDefined();
    expect(mockOnUnlock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Also test with only whitespace
    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(unlockButton);

    expect(screen.getByText('Please enter the operator access token.')).toBeDefined();
    expect(mockOnUnlock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls onUnlock exactly once after successful readiness and credential checks', async () => {
    const mockOnUnlock = vi.fn();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/v1/ready')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              status: 'ready',
              database: 'connected',
              timestamp: '2026-08-23T00:00:00.000Z',
            }),
        });
      }

      if (url.endsWith('/api/v1/operator/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              authenticated: true,
            }),
        });
      }

      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    render(<UnlockScreen onUnlock={mockOnUnlock} />);

    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: syntheticToken } });

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    await waitFor(() => {
      expect(mockOnUnlock).toHaveBeenCalledTimes(1);
      expect(mockOnUnlock).toHaveBeenCalledWith(syntheticToken);
    });
  });

  it('displays specific invalid-token message for UNAUTHORIZED failure and does not call onUnlock', async () => {
    const mockOnUnlock = vi.fn();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/v1/ready')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              status: 'ready',
              database: 'connected',
              timestamp: '2026-08-23T00:00:00.000Z',
            }),
        });
      }

      if (url.endsWith('/api/v1/operator/session')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              error: 'UNAUTHORIZED',
              message: 'Invalid operator token.',
            }),
        });
      }

      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    render(<UnlockScreen onUnlock={mockOnUnlock} />);

    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: 'not-a-real-invalid-token' } });

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    await waitFor(() => {
      expect(
        screen.getByText('Invalid operator access token. Please check your credentials.'),
      ).toBeDefined();
    });

    expect(mockOnUnlock).not.toHaveBeenCalled();
  });

  it('displays network failure message when connection to API server fails and does not call onUnlock', async () => {
    const mockOnUnlock = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    render(<UnlockScreen onUnlock={mockOnUnlock} />);

    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: syntheticToken } });

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Unable to connect to FalseRoute API server. Please ensure the backend is running.',
        ),
      ).toBeDefined();
    });

    expect(mockOnUnlock).not.toHaveBeenCalled();
  });

  it('displays backend unreachable message when API server responds with malformed payload and does not call onUnlock', async () => {
    const mockOnUnlock = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: { get: () => 'text/html' },
      json: () => Promise.reject(new SyntaxError('Invalid JSON')),
    });

    render(<UnlockScreen onUnlock={mockOnUnlock} />);

    const input = screen.getByLabelText('Operator Access Token');
    fireEvent.change(input, { target: { value: syntheticToken } });

    const unlockButton = screen.getByRole('button', { name: 'Unlock Dashboard' });
    fireEvent.click(unlockButton);

    await waitFor(() => {
      expect(screen.getByText('FalseRoute API backend is unreachable.')).toBeDefined();
    });

    expect(mockOnUnlock).not.toHaveBeenCalled();
  });
});
