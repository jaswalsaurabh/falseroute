import { type Request } from 'express';
import { createHash } from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Non-secret verified principal label or fingerprint, set by authentication middleware
       * after successful verification. Never holds a bearer token or secret.
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
 * Resolves the rate-limit identity for a request:
 * - When authenticated: verified non-secret principal fingerprint paired with source IP
 *   (providing secondary source-IP isolation under shared credentials).
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
 * By default ('composite'), authenticated keys incorporate both the verified principal
 * and the source IP (`principal:<id>:ip:<address>`) so a single source cannot consume
 * the entire shared principal allowance for other legitimate sources.
 */
export function formatLimiterKey(
  identity: LimiterIdentity,
  mode: 'composite' | 'ip' | 'principal' = 'composite',
): string {
  if (identity.kind === 'principal') {
    if (mode === 'principal') {
      return `principal:${identity.id}`;
    }
    if (mode === 'ip') {
      return `ip:${identity.sourceIp}`;
    }
    return `principal:${identity.id}:ip:${identity.sourceIp}`;
  }
  return `ip:${identity.address}`;
}
