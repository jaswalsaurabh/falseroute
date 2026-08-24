import { describe, expect, it } from 'vitest';
import {
  OPERATOR_CSRF_COOKIE,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_TTL_SECONDS,
  createOperatorSession,
  readCookie,
  sessionCookieHeaders,
  verifyOperatorSession,
} from './operator-session.js';

const sessionSecret = 'dummy-not-a-real-session-secret';
const nowMs = Date.UTC(2026, 7, 24);

describe('operator session helpers', () => {
  it('creates a session that verifies until its expiry and rejects tampering', () => {
    const session = createOperatorSession(sessionSecret, nowMs);

    expect(verifyOperatorSession(session.value, sessionSecret, nowMs)).toBe(true);
    expect(
      verifyOperatorSession(
        session.value,
        sessionSecret,
        nowMs + OPERATOR_SESSION_TTL_SECONDS * 1000,
      ),
    ).toBe(false);
    expect(verifyOperatorSession(`${session.value}tampered`, sessionSecret, nowMs)).toBe(false);
  });

  it('reads encoded cookies and fails closed for malformed encoding', () => {
    expect(
      readCookie('other=value; falseroute_operator_csrf=csrf%2Btoken', OPERATOR_CSRF_COOKIE),
    ).toBe('csrf+token');
    expect(
      readCookie(`${OPERATOR_SESSION_COOKIE}=%E0%A4%A`, OPERATOR_SESSION_COOKIE),
    ).toBeUndefined();
  });

  it('marks the session cookie HttpOnly and keeps CSRF separate', () => {
    const session = createOperatorSession(sessionSecret, nowMs);
    const headers = sessionCookieHeaders(session, true);

    expect(headers[0]).toContain(`${OPERATOR_SESSION_COOKIE}=`);
    expect(headers[0]).toContain('HttpOnly');
    expect(headers[0]).toContain('Secure');
    expect(headers[1]).toContain(`${OPERATOR_CSRF_COOKIE}=`);
    expect(headers[1]).not.toContain('HttpOnly');
  });
});
