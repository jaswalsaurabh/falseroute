import { describe, expect, it } from 'vitest';
import { TokenBucketCounter, createRateLimiter } from './rate-limit.js';
import {
  computeCredentialFingerprint,
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

  it('bounds memory storage and evicts least recently used entries under high key churn', () => {
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

    // Add 6th key -> should evict ip-1 (the oldest unaccessed key)
    counter.consume('ip-5');
    expect(counter.size).toBe(5);
    expect(counter.getRecord('ip-1')).toBeUndefined();
    expect(counter.getRecord('ip-0')).toBeDefined();
    expect(counter.getRecord('ip-5')).toBeDefined();
  });

  it('prunes expired idle entries properly', () => {
    let now = 1_000_000;
    const counter = new TokenBucketCounter({
      budget: testBudget,
      clock: () => now,
    });

    counter.consume('ip-1');
    counter.consume('ip-2');
    expect(counter.size).toBe(2);

    // Advance past idle expiration window (2 * 60_000 = 120_000ms)
    now += 150_000;

    const pruned = counter.pruneExpired();
    expect(pruned).toBe(2);
    expect(counter.size).toBe(0);
  });
});

describe('Principal and Limiter Identity Helpers', () => {
  it('computes stable non-secret SHA-256 fingerprint from tokens', () => {
    const fp1 = computeCredentialFingerprint('dummy-token-12345', 'operator');
    const fp2 = computeCredentialFingerprint('dummy-token-12345', 'operator');
    const fp3 = computeCredentialFingerprint('different-token-67890', 'operator');

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

  it('resolves authenticated identity to composite principal and source IP', () => {
    const req = { principalId: 'operator:abc1234', ip: '198.51.100.2', socket: {} } as Request;
    const identity = resolveLimiterIdentity(req);
    expect(identity).toEqual({
      kind: 'principal',
      id: 'operator:abc1234',
      sourceIp: '198.51.100.2',
    });
    expect(formatLimiterKey(identity, 'composite')).toBe(
      'principal:operator:abc1234:ip:198.51.100.2',
    );
    expect(formatLimiterKey(identity, 'principal')).toBe('principal:operator:abc1234');
    expect(formatLimiterKey(identity, 'ip')).toBe('ip:198.51.100.2');
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
});
