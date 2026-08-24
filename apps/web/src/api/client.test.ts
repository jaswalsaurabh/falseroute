import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiError } from './client.js';

describe('ApiClient', () => {
  const syntheticToken = 'not-a-real-local-operator-token';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serializes the complete intrusion-event query without losing zero offset', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ events: [], total: 0, limit: 25, offset: 0 }),
    });
    const client = new ApiClient(syntheticToken, 'https://example.invalid');

    await client.listEvents({
      limit: 25,
      offset: 0,
      status: 'DECIDED',
      search: 'configuration probe',
      sortBy: 'occurredAt',
      sortDirection: 'asc',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.invalid/api/v1/intrusion-events?limit=25&offset=0&status=DECIDED&search=configuration+probe&sortBy=occurredAt&sortDirection=asc',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('performs successful readiness check and authenticated event-list validation', async () => {
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      fetchCalls.push({
        url,
        headers: (init?.headers as Record<string, string>) || {},
      });

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

    const client = new ApiClient(syntheticToken);

    // Verify readiness check
    const readiness = await client.checkReadiness();
    expect(readiness.status).toBe('ready');
    expect(readiness.database).toBe('connected');

    // Verify credential validation (which checks readiness probe then operator session endpoint)
    await expect(client.validateCredentials()).resolves.toBeUndefined();

    // Verify headers included Bearer token
    const sessionCall = fetchCalls.find((call) => call.url.endsWith('/api/v1/operator/session'));
    expect(sessionCall).toBeDefined();
    expect(sessionCall?.headers.Authorization).toBe(`Bearer ${syntheticToken}`);
  });

  it('returns UNAUTHORIZED ApiError when operator token is invalid', async () => {
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
          statusText: 'Unauthorized',
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              error: 'UNAUTHORIZED',
              message: 'Invalid operator credentials.',
            }),
        });
      }

      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    const client = new ApiClient('not-a-real-invalid-token');

    await expect(client.validateCredentials()).rejects.toThrow(ApiError);

    try {
      await client.validateCredentials();
      expect.fail('Should have thrown an ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('UNAUTHORIZED');
      expect(apiError.message).toBe('Invalid operator credentials.');
    }
  });

  it('returns NETWORK_ERROR ApiError when network request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const client = new ApiClient(syntheticToken);

    try {
      await client.checkReadiness();
      expect.fail('Should have thrown an ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('NETWORK_ERROR');
      expect(apiError.message).toBe(
        'Unable to connect to FalseRoute API server. Please ensure the backend is running.',
      );
    }
  });

  it('returns BACKEND_UNREACHABLE ApiError without hardcoded URLs when response is malformed or non-JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: { get: () => 'text/html' },
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });

    const client = new ApiClient(syntheticToken);

    try {
      await client.checkReadiness();
      expect.fail('Should have thrown an ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('BACKEND_UNREACHABLE');
      expect(apiError.message).toBe('FalseRoute API backend is unreachable.');
      expect(apiError.message).not.toContain('http://127.0.0.1');
      expect(apiError.message).not.toContain('3000');
    }
  });

  it('returns INVALID_PAYLOAD ApiError when valid HTTP response has an unexpected shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ unexpectedProperty: true }),
    });

    const client = new ApiClient(syntheticToken);

    try {
      await client.checkReadiness();
      expect.fail('Should have thrown an ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('INVALID_PAYLOAD');
      expect(apiError.message).toBe('API returned an unexpected response structure.');
    }
  });
});
