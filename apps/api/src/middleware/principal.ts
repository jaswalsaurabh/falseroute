import { type Request } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Non-secret verified principal label, set by authentication middleware
       * after successful verification. Never holds a bearer token or secret.
       */
      principalId?: string;
    }
  }
}

export type LimiterIdentity =
  | { readonly kind: 'principal'; readonly id: string }
  | { readonly kind: 'ip'; readonly address: string };

/**
 * Resolves the rate-limit identity for a request: the verified non-secret
 * principal when authenticated, otherwise a trusted-proxy-aware source IP
 * (Express `req.ip` honors the configured `trust proxy` setting).
 */
export function resolveLimiterIdentity(req: Request): LimiterIdentity {
  if (typeof req.principalId === 'string' && req.principalId.length > 0) {
    return { kind: 'principal', id: req.principalId };
  }
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  return { kind: 'ip', address };
}

/**
 * Renders a limiter key. Principal keys are stable non-secret labels; IP keys
 * carry the resolved source address. Raw bearer tokens never appear as keys.
 */
export function formatLimiterKey(identity: LimiterIdentity): string {
  if (identity.kind === 'principal') {
    return `principal:${identity.id}`;
  }
  return `ip:${identity.address}`;
}
