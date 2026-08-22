import { describe, expect, it } from 'vitest';
import { type Request, type Response } from 'express';
import { type ApiErrorResponse } from '@false-route/contracts';
import { FixedWindowCounter, createRateLimiter } from './rate-limit.js';
import { getRequestClassBudget } from '../config/rate-limits.js';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): void;
  setHeader(name: string, value: string): void;
}

function createMockRes(): MockRes {
  const state: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code: number) {
      state.statusCode = code;
      return state;
    },
    json(payload: unknown) {
      state.body = payload;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
  };
  return state;
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  const req = {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' } as unknown as Request['socket'],
    ip: '127.0.0.1',
    correlationId: 'corr-rate-limit-test',
  };
  return { ...req, ...overrides } as unknown as Request;
}

function assertTooManyRequests(res: MockRes): void {
  expect(res.statusCode).toBe(429);
  expect(res.headers['Retry-After']).toBeDefined();
  const body = res.body as ApiErrorResponse;
  expect(Object.keys(body).toSorted()).toEqual(['correlationId', 'error', 'message']);
  expect(body.error).toBe('TOO_MANY_REQUESTS');
  expect(body.correlationId).toBe('corr-rate-limit-test');
  expect(typeof body.message).toBe('string');
}

describe('FixedWindowCounter', () => {
  const budget = { windowMs: 60_000, maxRequests: 3 };

  it('allows up to the budget then rejects (threshold behavior)', () => {
    const counter = new FixedWindowCounter({ budget });
    expect(counter.consume('a').allowed).toBe(true);
    expect(counter.consume('a').allowed).toBe(true);
    expect(counter.consume('a').allowed).toBe(true);
    const denied = counter.consume('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('refills the full allowance after the window resets', () => {
    let now = 1_000_000;
    const counter = new FixedWindowCounter({ budget, clock: () => now });
    counter.consume('a');
    counter.consume('a');
    counter.consume('a');
    expect(counter.consume('a').allowed).toBe(false);
    now += 60_001;
    expect(counter.consume('a').allowed).toBe(true);
    expect(counter.consume('a').allowed).toBe(true);
    expect(counter.consume('a').allowed).toBe(true);
  });

  it('isolates keys so one key cannot exhaust another allowance', () => {
    const counter = new FixedWindowCounter({ budget });
    for (let i = 0; i < budget.maxRequests; i += 1) {
      expect(counter.consume('a').allowed).toBe(true);
    }
    expect(counter.consume('a').allowed).toBe(false);
    expect(counter.consume('b').allowed).toBe(true);
    for (let i = 0; i < budget.maxRequests - 1; i += 1) {
      expect(counter.consume('b').allowed).toBe(true);
    }
  });
});

const noopNext = (): void => undefined;

describe('createRateLimiter middleware', () => {
  it('keys authenticated traffic on the verified principal, not the token', () => {
    const limiter = createRateLimiter({ className: 'read' });
    const next = noopNext;
    let rejected = false;
    const res = createMockRes();
    const realRes = {
      ...res,
      status(code: number) {
        res.statusCode = code;
        return this as unknown as Response;
      },
      json(payload: unknown) {
        rejected = true;
        res.body = payload;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    } as unknown as Response;

    // Same principal across many tokens shares one budget.
    const req = (token: string) =>
      createMockReq({ principalId: 'operator', headers: { authorization: token } });

    for (let i = 0; i < 100; i += 1) {
      limiter(req(`token-${i}`), realRes, next);
    }
    // 101st request regardless of token is rejected.
    limiter(req('token-extra'), realRes, next);
    expect(rejected).toBe(true);
    expect(res.statusCode).toBe(429);
  });

  it('falls back to a trusted-proxy-aware source IP for anonymous traffic', () => {
    let now = 2_000_000;
    const limiter = createRateLimiter({
      className: 'health',
      clock: () => now,
    });
    const res = createMockRes();
    const realRes = {
      ...res,
      status(code: number) {
        res.statusCode = code;
        return this as unknown as Response;
      },
      json(payload: unknown) {
        res.body = payload;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    } as unknown as Response;

    const reqFor = (ip: string) =>
      createMockReq({
        ip,
        socket: { remoteAddress: ip } as unknown as Request['socket'],
      });

    const budget = getRequestClassBudget('health').maxRequests;
    for (let i = 0; i < budget; i += 1) {
      limiter(reqFor('203.0.113.10'), realRes, () => undefined);
    }
    expect(res.statusCode).toBe(200);
    limiter(reqFor('203.0.113.10'), realRes, () => undefined);
    assertTooManyRequests(res);
    expect(parseInt(res.headers['Retry-After'] as string, 10)).toBeLessThanOrEqual(60);

    // A different source address keeps its own budget.
    res.statusCode = 200;
    limiter(reqFor('203.0.113.11'), realRes, () => undefined);
    expect(res.statusCode).toBe(200);
  });

  it('returns bounded 429 responses with Retry-After guidance on rejection', () => {
    const limiter = createRateLimiter({ className: 'write' });
    const res = createMockRes();
    const realRes = {
      ...res,
      status(code: number) {
        res.statusCode = code;
        return this as unknown as Response;
      },
      json(payload: unknown) {
        res.body = payload;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    } as unknown as Response;
    const req = createMockReq({ principalId: 'operator' });

    const budget = getRequestClassBudget('write').maxRequests;
    for (let i = 0; i < budget; i += 1) {
      limiter(req, realRes, () => undefined);
    }
    limiter(req, realRes, () => undefined);
    assertTooManyRequests(res);
    expect(parseInt(res.headers['Retry-After'] as string, 10)).toBeGreaterThanOrEqual(1);
  });
});
