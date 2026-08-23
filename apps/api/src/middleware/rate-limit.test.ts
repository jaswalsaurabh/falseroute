import { describe, expect, it } from 'vitest';
import { TokenBucketCounter, createRateLimiter } from './rate-limit.js';
import {
  computeCredentialFingerprint,
  createPrincipalIdentifier,
  formatLimiterKey,
  resolveLimiterIdentity,
} from './principal.js';
import { type Request, type Response } from 'express';

const noop = () => undefined;

describe('TokenBucketCounter', () => {
  const testBudget = {
    windowMs: 60_000,
    maxRequests: 60,
    burstCapacity: 10,
    refillRatePerSecond: 1, // 1 token per 1000ms
  };

  it('allows initial burst up to capacity and denies subsequent requests', () => {
    let now = 1_000_000;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      clock: () => now,
    });

    for (let i = 0; i < 10; i++) {
      const res = counter.consume('client-1');
      expect(res.allowed).toBe(true);
      expect(res.remainingTokens).toBe(9 - i);
      expect(res.retryAfterMs).toBe(0);
    }

    const blocked = counter.consume('client-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000); // Needs 1 token at 1 token/sec = 1000ms
  });

  it('refills tokens partially and deterministically as time advances', () => {
    let now = 1_000_000;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      clock: () => now,
    });

    // Exhaust all 10 tokens
    for (let i = 0; i < 10; i++) {
      counter.consume('client-1');
    }
    expect(counter.consume('client-1').allowed).toBe(false);

    // Advance by 2500ms -> should refill 2.5 tokens
    now += 2500;

    const firstAfterRefill = counter.consume('client-1');
    expect(firstAfterRefill.allowed).toBe(true);
    // After consuming 1 token from 2.5 tokens, 1.5 tokens remain
    expect(firstAfterRefill.remainingTokens).toBeCloseTo(1.5, 1);

    const secondAfterRefill = counter.consume('client-1');
    expect(secondAfterRefill.allowed).toBe(true);
    expect(secondAfterRefill.remainingTokens).toBeCloseTo(0.5, 1);

    // Third request requires 1 token, only 0.5 available -> blocked
    const thirdAfterRefill = counter.consume('client-1');
    expect(thirdAfterRefill.allowed).toBe(false);
    expect(thirdAfterRefill.retryAfterMs).toBe(500); // 0.5 deficit / (1 token / 1000ms) = 500ms
  });

  it('never exceeds the burst capacity ceiling after long idle periods', () => {
    let now = 1_000_000;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      clock: () => now,
    });

    // Consume 5 tokens
    for (let i = 0; i < 5; i++) {
      counter.consume('client-1');
    }

    // Advance by 10 hours
    now += 36_000_000;

    // Consume 1 token
    const res = counter.consume('client-1');
    expect(res.allowed).toBe(true);
    // Should be clamped to capacity 10 - 1 = 9
    expect(res.remainingTokens).toBe(9);
  });

  it('isolates counters between distinct client keys', () => {
    let now = 1_000_000;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      clock: () => now,
    });

    for (let i = 0; i < 10; i++) {
      counter.consume('client-1');
    }
    expect(counter.consume('client-1').allowed).toBe(false);

    // client-2 is completely fresh
    expect(counter.consume('client-2').allowed).toBe(true);
  });

  it('bounds memory storage and evicts least recently used entries under high key churn in O(1)', () => {
    let now = 1_000_000;
    const maxKeys = 5;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      maxKeys,
      clock: () => now,
    });

    for (let i = 0; i < 5; i++) {
      counter.consume(`ip-${i}`);
    }
    expect(counter.size).toBe(5);

    // Access ip-0 to refresh its LRU position
    counter.consume('ip-0');

    // Add 6th key -> should evict ip-1 (the oldest unaccessed key) in O(1)
    counter.consume('ip-5');
    expect(counter.size).toBe(5);
    expect(counter.getRecord('ip-1')).toBeUndefined();
    expect(counter.getRecord('ip-0')).toBeDefined();
    expect(counter.getRecord('ip-5')).toBeDefined();
  });

  it('prunes expired idle entries only when fully refilled and retains partially refilled idle entries', () => {
    let now = 1_000_000;
    // Budget with 100 capacity, refilling 1 token every 10s (0.1 token/s)
    const slowRefillBudget = {
      windowMs: 60_000,
      maxRequests: 60,
      burstCapacity: 100,
      refillRatePerSecond: 0.1,
    };
    const counter = new TokenBucketCounter({
      budget: slowRefillBudget,
      clock: () => now,
    });

    // Client 1 consumes 1 token (99 remaining). Refilling 1 token needs 10s.
    counter.consume('client-1');
    // Client 2 consumes 50 tokens (50 remaining). Refilling 50 tokens needs 500s.
    counter.consume('client-2', 50);

    // Advance by 120s (past idle threshold of 2 * 60s = 120s).
    // In 120s, client-1 refills 12 tokens -> reaches capacity 100 (fully refilled).
    // In 120s, client-2 refills 12 tokens -> reaches 62 tokens (NOT fully refilled, still has deficit).
    now += 121_000;

    const pruned = counter.pruneExpired(120_000);
    expect(pruned).toBe(1);
    expect(counter.getRecord('client-1')).toBeUndefined();
    expect(counter.getRecord('client-2')).toBeDefined();
    expect(counter.size).toBe(1);
  });
});

describe('Principal and Limiter Identity Helpers', () => {
  it('computes stable non-secret SHA-256 fingerprint from tokens', () => {
    const fp1 = computeCredentialFingerprint('dummy-token-12345', 'operator');
    const fp2 = computeCredentialFingerprint('dummy-token-12345', 'operator');
    const fp3 = computeCredentialFingerprint('different-dummy-token-67890', 'operator');

    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1.startsWith('operator:')).toBe(true);
    expect(fp1).not.toContain('dummy-token-12345');
  });

  it('resolves unauthenticated identity to source IP', () => {
    const req = { ip: '198.51.100.1', socket: {} } as Request;
    const identity = resolveLimiterIdentity(req);
    expect(identity).toEqual({ kind: 'ip', address: '198.51.100.1' });
    expect(formatLimiterKey(identity)).toBe('ip:198.51.100.1');
  });

  it('resolves authenticated identity to per-principal key by default and supports other modes', () => {
    const req = { principalId: 'operator:abc1234', ip: '198.51.100.2', socket: {} } as Request;
    const identity = resolveLimiterIdentity(req);
    expect(identity).toEqual({
      kind: 'principal',
      id: 'operator:abc1234',
      sourceIp: '198.51.100.2',
    });
    // Default mode enforces aggregate per-principal limit across all source IPs
    expect(formatLimiterKey(identity)).toBe('principal:operator:abc1234');
    expect(formatLimiterKey(identity, 'principal')).toBe('principal:operator:abc1234');
    expect(formatLimiterKey(identity, 'ip')).toBe('ip:198.51.100.2');
    expect(formatLimiterKey(identity, 'composite')).toBe(
      'principal:operator:abc1234:ip:198.51.100.2',
    );
  });

  it('createPrincipalIdentifier identifies valid tokens and leaves unauthenticated requests untouched', () => {
    const identifier = createPrincipalIdentifier({ expectedToken: 'not-a-real-test-token' });

    const validReq = {
      headers: { authorization: 'Bearer not-a-real-test-token' },
    } as unknown as Request;
    identifier(validReq, {} as Response, noop);
    expect(validReq.principalId).toBeDefined();
    expect(validReq.principalId?.startsWith('operator:')).toBe(true);

    const invalidReq = {
      headers: { authorization: 'Bearer not-a-real-invalid-token' },
    } as unknown as Request;
    identifier(invalidReq, {} as Response, noop);
    expect(invalidReq.principalId).toBeUndefined();

    const noAuthReq = { headers: {} } as unknown as Request;
    identifier(noAuthReq, {} as Response, noop);
    expect(noAuthReq.principalId).toBeUndefined();
  });
});

describe('createRateLimiter middleware', () => {
  it('sets Retry-After header and returns 429 when budget is exhausted', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({
      className: 'write',
      clock: () => now,
    });

    const req = {
      ip: '198.51.100.5',
      socket: {},
      correlationId: 'corr-test-429',
    } as unknown as Request;

    const headers: Record<string, string> = {};
    let statusCode = 200;
    let jsonBody: unknown = null;

    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        jsonBody = body;
        return res;
      },
    } as unknown as Response;

    // Write burst capacity is 10
    for (let i = 0; i < 10; i++) {
      limiter(req, res, noop);
      expect(statusCode).toBe(200);
    }

    // 11th request must be rejected with 429
    limiter(req, res, noop);
    expect(statusCode).toBe(429);
    expect(headers['Retry-After']).toBeDefined();
    expect(parseInt(headers['Retry-After'] as string, 10)).toBeGreaterThanOrEqual(1);
    expect(jsonBody).toEqual({
      error: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('write'),
      correlationId: 'corr-test-429',
    });
  });

  it('enforces a secondary source-IP budget across distinct principals', () => {
    const limiter = createRateLimiter({
      className: 'write',
      secondaryKeyMode: 'ip',
      customBudget: {
        windowMs: 60_000,
        maxRequests: 2,
        burstCapacity: 2,
        refillRatePerSecond: 2 / 60,
      },
      clock: () => 1_000_000,
    });
    let statusCode = 200;
    let nextCalls = 0;
    const res = {
      setHeader: noop,
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Response;

    for (const principalId of ['operator:alpha', 'operator:beta']) {
      limiter(
        {
          principalId,
          ip: '198.51.100.10',
          socket: {},
          correlationId: 'corr-secondary-ip',
        } as unknown as Request,
        res,
        () => {
          nextCalls += 1;
        },
      );
    }
    limiter(
      {
        principalId: 'operator:gamma',
        ip: '198.51.100.10',
        socket: {},
        correlationId: 'corr-secondary-ip',
      } as unknown as Request,
      res,
      () => {
        nextCalls += 1;
      },
    );

    expect(nextCalls).toBe(2);
    expect(statusCode).toBe(429);
    expect(limiter.secondaryCounter?.getRecord('ip:198.51.100.10')?.tokens).toBe(0);
  });

  it('enforces the principal budget across distinct source IPs', () => {
    const limiter = createRateLimiter({
      className: 'write',
      secondaryKeyMode: 'ip',
      customBudget: {
        windowMs: 60_000,
        maxRequests: 2,
        burstCapacity: 2,
        refillRatePerSecond: 2 / 60,
      },
      clock: () => 1_000_000,
    });
    let statusCode = 200;
    let nextCalls = 0;
    const res = {
      setHeader: noop,
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Response;

    for (const ip of ['198.51.100.11', '198.51.100.12', '198.51.100.13']) {
      limiter(
        {
          principalId: 'operator:shared',
          ip,
          socket: {},
          correlationId: 'corr-primary-principal',
        } as unknown as Request,
        res,
        () => {
          nextCalls += 1;
        },
      );
    }

    expect(nextCalls).toBe(2);
    expect(statusCode).toBe(429);
    expect(limiter.counter.getRecord('principal:operator:shared')?.tokens).toBe(0);
    expect(limiter.secondaryCounter?.getRecord('ip:198.51.100.13')).toBeUndefined();
  });

  it('enforces default class secondary IP boundary across distinct synthetic principals and avoids double consumption for unauthenticated requests', () => {
    const limiter = createRateLimiter({
      className: 'default',
      secondaryKeyMode: 'ip',
      customBudget: {
        windowMs: 60_000,
        maxRequests: 2,
        burstCapacity: 2,
        refillRatePerSecond: 2 / 60,
      },
      maxKeys: 2,
      clock: () => 1_000_000,
    });
    let statusCode = 200;
    let nextCalls = 0;
    const res = {
      setHeader: noop,
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Response;

    // 1. Unauthenticated request: key is ip:198.51.100.20, secondaryKey is also ip:198.51.100.20
    // Must NOT consume secondary counter (secondaryKey === key)
    limiter(
      {
        ip: '198.51.100.20',
        socket: {},
        correlationId: 'corr-unauth-1',
      } as unknown as Request,
      res,
      () => {
        nextCalls += 1;
      },
    );
    expect(nextCalls).toBe(1);
    expect(limiter.counter.getRecord('ip:198.51.100.20')?.tokens).toBe(1);
    expect(limiter.secondaryCounter?.getRecord('ip:198.51.100.20')).toBeUndefined();

    // 2. Distinct synthetic principals on same IP exhaust secondary IP counter
    const p1Req = {
      principalId: 'operator:synth-1',
      ip: '198.51.100.30',
      socket: {},
      correlationId: 'corr-synth-1',
    } as unknown as Request;
    const p2Req = {
      principalId: 'operator:synth-2',
      ip: '198.51.100.30',
      socket: {},
      correlationId: 'corr-synth-2',
    } as unknown as Request;
    const p3Req = {
      principalId: 'operator:synth-3',
      ip: '198.51.100.30',
      socket: {},
      correlationId: 'corr-synth-3',
    } as unknown as Request;

    limiter(p1Req, res, () => {
      nextCalls += 1;
    });
    limiter(p2Req, res, () => {
      nextCalls += 1;
    });
    // 3rd principal on same IP should be blocked by secondary IP counter
    limiter(p3Req, res, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(3);
    expect(statusCode).toBe(429);
    expect(limiter.secondaryCounter?.getRecord('ip:198.51.100.30')?.tokens).toBe(0);

    // 3. Primary and secondary counters independently perform bounded LRU eviction
    expect(limiter.counter.size).toBeLessThanOrEqual(2);
    expect(limiter.secondaryCounter?.size).toBeLessThanOrEqual(2);
  });
});
