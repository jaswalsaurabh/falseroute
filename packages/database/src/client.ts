import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from './generated/client/client.js';

export interface DatabaseClientOptions {
  connectionString: string;
}

export type DatabaseClient = PrismaClient;

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
 * Creates an isolated Prisma database client backed by the PostgreSQL driver adapter.
 *
 * Requirements:
 * - Connection string is injected explicitly (no ambient process.env reading).
 * - No network I/O or connections are established during import or client instantiation.
 * - Connections are opened lazily by pg.Pool upon query execution or explicit $connect().
 */
export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  if (!options || typeof options.connectionString !== 'string') {
    throw new TypeError(
      'Database client requires an explicit options object with a connectionString property.',
    );
  }

  const trimmed = options.connectionString.trim();
  if (trimmed === '') {
    throw new Error('Database client connectionString cannot be empty.');
  }

  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    const sanitized = sanitizeConnectionString(trimmed);
    throw new Error(
      `Database connectionString must begin with "postgresql://" or "postgres://", received: ${sanitized}`,
    );
  }

  const pool = new Pool({
    connectionString: trimmed,
  });

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export { validateTestDatabaseUrl } from './test-database.js';
