/**
 * Redacts potential credentials from a connection string or error detail.
 */
function sanitizeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '*****';
    }
    if (url.username) {
      url.username = '*****';
    }
    return url.toString();
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}

/**
 * Validates that an explicitly provided database URL targets a dedicated test database.
 * Rejects undefined/empty URLs, non-PostgreSQL URLs, development databases, and any database
 * that does not end with '_test' (e.g. 'falseroute_test').
 */
export function validateTestDatabaseUrl(url?: string | undefined): string {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error(
      'CRITICAL: An explicit test database URL must be provided via TEST_DATABASE_URL or DATABASE_URL.',
    );
  }

  const trimmed = url.trim();
  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    const sanitized = sanitizeConnectionString(trimmed);
    throw new Error(
      `CRITICAL: Test database connectionString must begin with "postgresql://" or "postgres://", received: ${sanitized}`,
    );
  }

  let dbName: string;
  try {
    const parsed = new URL(trimmed);
    dbName = parsed.pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    throw new Error(
      `CRITICAL: Malformed test database URL provided: "${sanitizeConnectionString(trimmed)}"`,
    );
  }

  if (!dbName || !dbName.endsWith('_test')) {
    throw new Error(
      `CRITICAL: Integration tests must run against a dedicated test database whose name ends with '_test' (e.g. 'falseroute_test'), received database: '${dbName || '[none]'}'.`,
    );
  }

  if (
    dbName === 'falseroute_dev' ||
    dbName.includes('dev') ||
    dbName.includes('prod') ||
    dbName.includes('staging')
  ) {
    throw new Error(
      `CRITICAL: Integration tests cannot run against dev/staging/prod database: '${dbName}'.`,
    );
  }

  return trimmed;
}
