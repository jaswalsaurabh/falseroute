/**
 * Sensitive field names and paths for structured log redaction.
 */
export const DEFAULT_REDACTION_PATHS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'operatorToken',
  'databaseUrl',
  'DATABASE_URL',
  'decoyCredential',
  'prompt',
  'rawPrompt',
  'modelResponse',
  'rawResponse',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.operatorToken',
  '*.databaseUrl',
  '*.DATABASE_URL',
  '*.prompt',
  '*.rawPrompt',
  '*.modelResponse',
  '*.rawResponse',
];

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|set-cookie|token|password|secret|apikey|api_key|operatortoken|operator_access_token|access_token|databaseurl|database_url|prompt|rawprompt|raw_prompt|modelresponse|rawresponse|decoycredential|decoy_credential|credential)/i;

const URL_CREDENTIAL_PATTERN = /:\/\/([^:]+):([^@]+)@/g;

/**
 * Strips credentials embedded in database or service URLs.
 */
export function sanitizeUrlCredentials(value: string): string {
  return value.replace(URL_CREDENTIAL_PATTERN, '://$1:[REDACTED]@');
}

/**
 * Pure recursive sanitization for plain JavaScript objects and errors before serialization.
 */
export function sanitizeLogData<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeUrlCredentials(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item)) as unknown as T;
  }

  if (data instanceof Error) {
    const sanitizedError: Record<string, unknown> = {
      name: data.name,
      message: sanitizeUrlCredentials(data.message),
    };
    if (data.stack) {
      sanitizedError.stack = sanitizeUrlCredentials(data.stack);
    }
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitizedError[key] = REDACTED_PLACEHOLDER;
      } else {
        sanitizedError[key] = sanitizeLogData(value);
      }
    }
    return sanitizedError as unknown as T;
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED_PLACEHOLDER;
      } else {
        sanitized[key] = sanitizeLogData(value);
      }
    }
    return sanitized as unknown as T;
  }

  return data;
}
