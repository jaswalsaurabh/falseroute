import { describe, expect, it } from 'vitest';
import { type Request, type Response } from 'express';
import { createOverloadGuard } from './load-shed.js';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): void;
  setHeader(name: string, value: string): void;
  listeners: Record<string, () => void>;
  on(event: 'finish' | 'close', cb: () => void): void;
  finish(): void;
  close(): void;
}

function createMockRes(): MockRes {
  const state: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    listeners: {},
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
    on(event: 'finish' | 'close', cb: () => void) {
      state.listeners[event] = cb;
    },
    finish() {
      state.listeners['finish']?.();
    },
    close() {
      state.listeners['close']?.();
    },
  };
  return state;
}

function createMockReq(): Request {
  return { correlationId: 'corr-load-shed-test' } as unknown as Request;
}

const noopNext = (): void => undefined;

describe('createOverloadGuard', () => {
  it('sheds requests with 503 SERVICE_OVERLOAD once the in-flight ceiling is reached', () => {
    const { middleware } = (() => {
      const guard = createOverloadGuard({ maxInFlight: 1 });
      return { middleware: guard };
    })();

    let firstNextCalls = 0;
    const res1 = createMockRes();
    middleware(createMockReq(), res1 as unknown as Response, () => {
      firstNextCalls += 1;
    });
    expect(firstNextCalls).toBe(1);

    const res2 = createMockRes();
    const next2 = noopNext;
    middleware(createMockReq(), res2 as unknown as Response, next2);
    expect(res2.statusCode).toBe(503);
    const body = res2.body as { error: string };
    expect(body.error).toBe('SERVICE_OVERLOAD');
    expect(res2.headers['Retry-After']).toBeDefined();
    expect(res2.headers['Retry-After']).not.toBe('1');
  });

  it('releases the slot when a request finishes, allowing new work', () => {
    const guard = createOverloadGuard({ maxInFlight: 1 });
    const res1 = createMockRes();
    guard(createMockReq(), res1 as unknown as Response, () => undefined);
    res1.finish();

    const res2 = createMockRes();
    let next2Calls = 0;
    guard(createMockReq(), res2 as unknown as Response, () => {
      next2Calls += 1;
    });
    expect(next2Calls).toBe(1);
    expect(res2.statusCode).toBe(200);
  });

  it('distinguishes deployment overload from a client quota rejection', () => {
    const guard = createOverloadGuard({ maxInFlight: 1 });
    const res1 = createMockRes();
    guard(createMockReq(), res1 as unknown as Response, () => undefined);

    const res2 = createMockRes();
    guard(createMockReq(), res2 as unknown as Response, () => undefined);
    expect(res2.statusCode).toBe(503);
    const body = res2.body as { error: string; message: string; correlationId: string };
    expect(body.error).toBe('SERVICE_OVERLOAD');
    expect(Object.keys(body).toSorted()).toEqual(['correlationId', 'error', 'message']);
    expect(body.correlationId).toBe('corr-load-shed-test');
    expect(res2.headers['Retry-After']).toBeDefined();
  });
});
