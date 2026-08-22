import { ZodError } from 'zod';

export type ProviderErrorKind =
  | 'TRANSIENT'
  | 'SCHEMA_INVALID'
  | 'AUTH_OR_CONFIG'
  | 'CLIENT_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONCURRENCY_SATURATED'
  | 'TERMINAL';

export interface ClassifiedProviderError {
  readonly kind: ProviderErrorKind;
  readonly isRetriable: boolean;
  readonly status: 'TIMEOUT' | 'INVALID_OUTPUT' | 'UNAVAILABLE' | 'DEGRADED';
  readonly sanitizedReason: string;
  readonly httpStatus?: number | undefined;
}

/**
 * Extracts a numeric HTTP status code if present on the error object or in its message.
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }

  const candidate = err as Record<string, unknown>;
  if (typeof candidate['status'] === 'number') {
    return candidate['status'];
  }
  if (typeof candidate['statusCode'] === 'number') {
    return candidate['statusCode'];
  }
  if (
    typeof candidate['response'] === 'object' &&
    candidate['response'] !== null &&
    typeof (candidate['response'] as Record<string, unknown>)['status'] === 'number'
  ) {
    return (candidate['response'] as Record<string, unknown>)['status'] as number;
  }

  if (typeof candidate['message'] === 'string') {
    const msg = candidate['message'];
    const match = msg.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }

  return undefined;
}

/**
 * Strips credentials, tokens, keys, URLs, headers, and structured JSON secrets from messages.
 * Normalizes multiline whitespace and truncates to max 500 chars to prevent unbounded payloads.
 */
export function sanitizeErrorMessage(message: string): string {
  const sanitized = message
    // Redact quoted JSON key-value pairs e.g. "apiKey": "...", 'accessToken': '...'
    .replace(
      /(["']?)(?:api_?[kK]ey|access_?[tT]oken|client_?[sS]ecret|password|bearer|secret|token|authorization|key)\1\s*[:=]\s*(["'])[^"']*\2/gi,
      '[REDACTED]',
    )
    // Redact Authorization headers and Bearer tokens
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi, 'Bearer [REDACTED]')
    // Redact key=value or key: value unquoted credential patterns
    .replace(
      /(?:api_?[kK]ey|access_?[tT]oken|client_?[sS]ecret|password|secret|token|bearer|key)[=:\s]+[A-Za-z0-9_\-.~+/=]+/gi,
      '[REDACTED]',
    )
    // Redact credential-bearing URLs and any HTTP/HTTPS URLs
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    // Normalize newlines, tabs, and multiple spaces
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return sanitized.length > 500 ? `${sanitized.slice(0, 497)}...` : sanitized;
}

/**
 * Classifies an unknown error encountered during provider enrichment into explicit resilience categories.
 * Strict rules:
 * - Raw provider error messages, response bodies, and prompts must NEVER be persisted or exposed in sanitizedReason.
 * - sanitizedReason must always be a small, classification-specific allowlisted message preserving useful non-sensitive details.
 * - Never retry schema validation errors or JSON parse errors.
 * - Never retry 400, 401, 403, 404, or configuration errors.
 * - Retry only transient server errors (500, 502, 503, 504), rate limits (429), network resets, and per-request timeouts.
 */
export function classifyProviderError(err: unknown): ClassifiedProviderError {
  // 1. Schema/Syntax errors
  if (
    err instanceof ZodError ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ZodError')
  ) {
    return {
      kind: 'SCHEMA_INVALID',
      isRetriable: false,
      status: 'INVALID_OUTPUT',
      sanitizedReason: 'Provider output violated schema contract',
    };
  }

  if (
    err instanceof SyntaxError ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SyntaxError')
  ) {
    return {
      kind: 'SCHEMA_INVALID',
      isRetriable: false,
      status: 'INVALID_OUTPUT',
      sanitizedReason: 'Provider returned non-JSON or invalid structured syntax',
    };
  }

  const rawMessage =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  const lowerMessage = rawMessage.toLowerCase();
  const errorCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as Record<string, unknown>)['code'])
      : '';

  // 2. Explicit cancellation and overall deadline state
  if (
    lowerMessage.includes('operation deadline') ||
    lowerMessage.includes('overall deadline') ||
    (err instanceof Error && err.name === 'AbortError' && lowerMessage.includes('deadline'))
  ) {
    return {
      kind: 'TIMEOUT',
      isRetriable: false,
      status: 'TIMEOUT',
      sanitizedReason: 'Operation deadline exceeded',
    };
  }

  if (lowerMessage.includes('cancelled') || lowerMessage.includes('canceled')) {
    return {
      kind: 'CANCELLED',
      isRetriable: false,
      status: 'TIMEOUT',
      sanitizedReason: 'Provider request cancelled',
    };
  }

  const httpStatus = extractHttpStatus(err);

  // 3. Explicit terminal HTTP statuses (take strict precedence over conflicting message words)
  if (httpStatus === 400) {
    return {
      kind: 'CLIENT_ERROR',
      isRetriable: false,
      status: 'INVALID_OUTPUT',
      sanitizedReason: 'Provider client error or invalid argument (HTTP 400)',
      httpStatus: 400,
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      kind: 'AUTH_OR_CONFIG',
      isRetriable: false,
      status: 'UNAVAILABLE',
      sanitizedReason: `Provider authentication or authorization failure (HTTP ${httpStatus})`,
      httpStatus,
    };
  }

  if (httpStatus === 404) {
    return {
      kind: 'AUTH_OR_CONFIG',
      isRetriable: false,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider resource or model not found (HTTP 404)',
      httpStatus: 404,
    };
  }

  // 4. Explicit 429 Rate Limiting
  if (httpStatus === 429) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider rate limit or quota reached (HTTP 429)',
      httpStatus: 429,
    };
  }

  // 5. Explicit supported 5xx Transient Server Errors
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: `Transient upstream server error (HTTP ${httpStatus})`,
      httpStatus,
    };
  }

  // 6. Known network error codes and timeout types
  if (
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    (err instanceof Error && err.name === 'AbortError')
  ) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'TIMEOUT',
      sanitizedReason: 'Provider request timeout',
      httpStatus: 504,
    };
  }

  const transientNetworkCodes = new Set([
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EPIPE',
    'UND_ERR_SOCKET',
  ]);
  if (transientNetworkCodes.has(errorCode)) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Transient network failure',
    };
  }

  // Concurrency saturation
  if (
    lowerMessage.includes('concurrency') ||
    lowerMessage.includes('saturated') ||
    lowerMessage.includes('queue full')
  ) {
    return {
      kind: 'CONCURRENCY_SATURATED',
      isRetriable: false,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider capacity saturated',
    };
  }

  // 7. Message heuristics only when no authoritative status or code is available
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('deadline')
  ) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'TIMEOUT',
      sanitizedReason: 'Provider request timeout',
      httpStatus: 504,
    };
  }

  if (
    lowerMessage.includes('resource_exhausted') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('quota')
  ) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider rate limit or quota reached (HTTP 429)',
      httpStatus: 429,
    };
  }

  if (
    lowerMessage.includes('unavailable') ||
    lowerMessage.includes('bad gateway') ||
    lowerMessage.includes('gateway timeout')
  ) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Transient upstream server error (HTTP 503)',
      httpStatus: 503,
    };
  }

  if (lowerMessage.includes('socket hang up') || lowerMessage.includes('fetch failed')) {
    return {
      kind: 'TRANSIENT',
      isRetriable: true,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Transient network failure',
    };
  }

  if (
    lowerMessage.includes('unauthenticated') ||
    lowerMessage.includes('permission_denied') ||
    lowerMessage.includes('invalid api key')
  ) {
    return {
      kind: 'AUTH_OR_CONFIG',
      isRetriable: false,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider authentication or authorization failure (HTTP 401)',
      httpStatus: 401,
    };
  }

  if (lowerMessage.includes('not found')) {
    return {
      kind: 'AUTH_OR_CONFIG',
      isRetriable: false,
      status: 'UNAVAILABLE',
      sanitizedReason: 'Provider resource or model not found (HTTP 404)',
      httpStatus: 404,
    };
  }

  if (lowerMessage.includes('invalid_argument') || lowerMessage.includes('bad request')) {
    return {
      kind: 'CLIENT_ERROR',
      isRetriable: false,
      status: 'INVALID_OUTPUT',
      sanitizedReason: 'Provider client error or invalid argument (HTTP 400)',
      httpStatus: 400,
    };
  }

  // 8. Generic unclassified terminal error
  return {
    kind: 'TERMINAL',
    isRetriable: false,
    status: 'UNAVAILABLE',
    sanitizedReason: httpStatus
      ? `Provider upstream failure (HTTP ${httpStatus})`
      : 'Provider upstream failure',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}
