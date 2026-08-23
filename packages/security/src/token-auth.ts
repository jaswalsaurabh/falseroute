import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison for operator access tokens using SHA-256 digests.
 * Prevents timing attacks and handles arbitrary length candidate tokens safely.
 */
export function verifyOperatorToken(
  candidateToken: string | undefined | null,
  expectedToken: string,
): boolean {
  if (!candidateToken || typeof candidateToken !== 'string') {
    return false;
  }

  const trimmedCandidate = candidateToken.trim();
  const trimmedExpected = expectedToken.trim();

  if (!trimmedCandidate || !trimmedExpected) {
    return false;
  }

  // Hash both inputs to guarantee fixed-length (32 bytes) buffers for timingSafeEqual
  const candidateHash = createHash('sha256').update(trimmedCandidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(trimmedExpected, 'utf8').digest();

  return timingSafeEqual(candidateHash, expectedHash);
}

/**
 * Extracts bearer token from an Authorization header value.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
    return parts[1] ?? null;
  }

  return null;
}
