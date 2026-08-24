import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPERATOR_SESSION_COOKIE = 'falseroute_operator_session';
export const OPERATOR_CSRF_COOKIE = 'falseroute_operator_csrf';
export const OPERATOR_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createOperatorSession(
  secret: string,
  nowMs = Date.now(),
): { readonly value: string; readonly csrfToken: string; readonly maxAge: number } {
  const expiresAt = Math.floor(nowMs / 1000) + OPERATOR_SESSION_TTL_SECONDS;
  const payload = `${expiresAt}.${randomBytes(32).toString('base64url')}`;
  return {
    value: `${payload}.${sign(payload, secret)}`,
    csrfToken: randomBytes(32).toString('base64url'),
    maxAge: OPERATOR_SESSION_TTL_SECONDS,
  };
}

export function verifyOperatorSession(
  value: string | undefined,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [expiresAt, nonce, providedSignature] = parts;
  const expires = Number(expiresAt);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1000) || !nonce) return false;
  const expectedSignature = sign(`${expiresAt}.${nonce}`, secret);
  const provided = Buffer.from(providedSignature ?? '', 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const entry of header?.split(';') ?? []) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookieHeaders(
  session: { readonly value: string; readonly csrfToken: string; readonly maxAge: number },
  secure: boolean,
): string[] {
  const security = `Max-Age=${session.maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const csrfSecurity = `Max-Age=${session.maxAge}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return [
    `${OPERATOR_SESSION_COOKIE}=${encodeURIComponent(session.value)}; ${security}`,
    `${OPERATOR_CSRF_COOKIE}=${encodeURIComponent(session.csrfToken)}; ${csrfSecurity}`,
  ];
}

export function clearedSessionCookieHeaders(secure: boolean): string[] {
  const security = `Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const csrfSecurity = `Max-Age=0; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return [`${OPERATOR_SESSION_COOKIE}=; ${security}`, `${OPERATOR_CSRF_COOKIE}=; ${csrfSecurity}`];
}
