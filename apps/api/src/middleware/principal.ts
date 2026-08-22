import { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { extractBearerToken, verifyOperatorToken } from '@false-route/security';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Non-secret verified principal label or fingerprint, set after successful verification.
       * Never holds a bearer token or secret.
       */
      principalId?: string;
    }
  }
}

export type LimiterIdentity =
  | { readonly kind: 'principal'; readonly id: string; readonly sourceIp: string }
  | { readonly kind: 'ip'; readonly address: string };

/**
 * Computes a non-secret stable credential fingerprint.
 * Never stores or exposes raw secrets or bearer tokens.
 */
export function computeCredentialFingerprint(token: string, label = 'operator'): string {
  const hash = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return `${label}:${hash}`;
}

/**
 * Early principal identification middleware.
 * If a valid operator bearer token is present in the Authorization header,
 * attaches the non-secret principal fingerprint to `req.principalId` so subsequent
 * global limiters (e.g. default quota) can enforce per-principal budgets.
 * Does not block or reject requests; route-level auth middleware enforces mandatory auth.
 */
export function createPrincipalIdentifier(options: { readonly expectedToken: string }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(req.headers.authorization);
    if (bearerToken !== null && verifyOperatorToken(bearerToken, options.expectedToken)) {
      req.principalId = computeCredentialFingerprint(bearerToken, 'operator');
    }
    next();
  };
}

/**
 * Resolves the rate-limit identity for a request:
 * - When authenticated: verified non-secret principal fingerprint.
 * - When unauthenticated: trusted-proxy-aware source IP (Express `req.ip`).
 */
export function resolveLimiterIdentity(req: Request): LimiterIdentity {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  if (typeof req.principalId === 'string' && req.principalId.length > 0) {
    return { kind: 'principal', id: req.principalId, sourceIp: address };
  }
  return { kind: 'ip', address };
}

/**
 * Formats a rate-limit key.
 * By default ('principal'), authenticated callers are keyed by their verified principal (`principal:<id>`)
 * enforcing aggregate principal budgets across all source IPs, with IP fallback for unauthenticated callers.
 * Mode 'ip' forces source-IP keying (e.g. for health checks and pre-auth failure tracking).
 * Mode 'composite' incorporates both principal and source IP (`principal:<id>:ip:<address>`).
 */
export function formatLimiterKey(
  identity: LimiterIdentity,
  mode: 'principal' | 'ip' | 'composite' = 'principal',
): string {
  if (identity.kind === 'principal') {
    if (mode === 'ip') {
      return `ip:${identity.sourceIp}`;
    }
    if (mode === 'composite') {
      return `principal:${identity.id}:ip:${identity.sourceIp}`;
    }
    return `principal:${identity.id}`;
  }
  return `ip:${identity.address}`;
}
