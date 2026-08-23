import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvironment, validateLocalDatabaseUrl } from './dev-supervisor-environment.ts';

export interface LocalResetValidationResult {
  valid: boolean;
  error?: string;
  databaseName?: string;
  maintenanceUrl?: string;
  targetUrl?: string;
}

const APPROVED_DEV_DB_NAMES = new Set(['falseroute_dev']);

/**
 * Validates that a connection URL strictly targets the local development database.
 * Rejects remote databases, production/staging names, test databases, and malformed URLs.
 */
export function validateLocalDevDatabaseUrl(url: string | undefined): LocalResetValidationResult {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return { valid: false, error: 'Missing required environment variable: DATABASE_URL' };
  }

  const localValidationError = validateLocalDatabaseUrl(url);
  if (localValidationError) {
    return { valid: false, error: localValidationError };
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { valid: false, error: 'DATABASE_URL must be a valid postgresql:// connection string' };
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0] ?? '';
  if (!APPROVED_DEV_DB_NAMES.has(dbName)) {
    return {
      valid: false,
      error: `Local reset is strictly restricted to approved development databases (${Array.from(APPROVED_DEV_DB_NAMES).join(', ')}). Received: "${dbName || '[none]'}"`,
    };
  }

  // Build maintenance connection URL pointing to postgres system database on the same instance
  const maintenance = new URL(parsed.toString());
  maintenance.pathname = '/postgres';
  maintenance.search = '';

  return {
    valid: true,
    databaseName: dbName,
    maintenanceUrl: maintenance.toString(),
    targetUrl: parsed.toString(),
  };
}

export interface ResetDatabaseOptions {
  rootDir?: string | undefined;
  env?: Record<string, string> | undefined;
  log?: ((message: string) => void) | undefined;
  logError?: ((message: string) => void) | undefined;
}

/**
 * Safely resets the local development database:
 * 1. Terminates active client connections to falseroute_dev.
 * 2. Drops and recreates falseroute_dev cleanly.
 * 3. Applies all approved Prisma migrations via prisma-guard.
 */
export async function resetLocalDevDatabase(options: ResetDatabaseOptions = {}): Promise<boolean> {
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const log = options.log ?? ((msg: string) => console.log(msg));
  const logError = options.logError ?? ((msg: string) => console.error(msg));

  const env = options.env ?? loadEnvironment({ rootDir }).env;
  const validation = validateLocalDevDatabaseUrl(env.DATABASE_URL);

  if (!validation.valid || !validation.databaseName || !validation.maintenanceUrl) {
    logError(`[dev-db-reset] Safety check failed: ${validation.error}`);
    return false;
  }

  const dbName = validation.databaseName;
  log(`[dev-db-reset] Resetting local development database: "${dbName}"...`);

  // Dynamically import pg Client to avoid top-level dependency in root test suites
  let ClientClass: new (opts: { connectionString: string }) => {
    connect(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
  try {
    const pgSpecifier = 'pg';
    const pgModule = (await import(pgSpecifier)) as {
      Client?: typeof ClientClass;
      default?: { Client?: typeof ClientClass };
    };
    const loaded = pgModule.Client || pgModule.default?.Client;
    if (!loaded) throw new Error('pg Client export not found');
    ClientClass = loaded;
  } catch {
    // Fallback: load pg from @false-route/database package
    try {
      const dbPgPath = resolve(rootDir, 'packages/database/node_modules/pg/lib/index.js');
      const pgModule = (await import(dbPgPath)) as {
        Client?: typeof ClientClass;
        default?: { Client?: typeof ClientClass };
      };
      const loaded = pgModule.Client || pgModule.default?.Client;
      if (!loaded) throw new Error('pg Client export not found in fallback');
      ClientClass = loaded;
    } catch (pgErr) {
      logError(
        `[dev-db-reset] Unable to load PostgreSQL client: ${(pgErr as Error).message}. Run 'pnpm install' first.`,
      );
      return false;
    }
  }

  const maintenanceClient = new ClientClass({ connectionString: validation.maintenanceUrl });
  try {
    await maintenanceClient.connect();

    // Terminate existing active connections to the target database
    await maintenanceClient.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid();`,
      [dbName],
    );

    // Drop and recreate database
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '""')}";`);
    await maintenanceClient.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}";`);
    log(`[dev-db-reset] Database "${dbName}" dropped and recreated successfully.`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(`[dev-db-reset] Failed during database recreation: ${errorMsg}`);
    return false;
  } finally {
    await maintenanceClient.end().catch(() => {});
  }

  // Deploy all approved Prisma migrations to the freshly initialized database
  log(`[dev-db-reset] Deploying Prisma migrations to "${dbName}"...`);
  const migrationRes = spawnSync('node', ['scripts/prisma-guard.ts', 'migrate', 'deploy'], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (migrationRes.status !== 0) {
    logError(`[dev-db-reset] Migration deployment failed with status ${migrationRes.status}`);
    return false;
  }

  log(`[dev-db-reset] Local development database "${dbName}" reset and migrated successfully.`);
  return true;
}

async function main(): Promise<void> {
  const success = await resetLocalDevDatabase();
  process.exit(success ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[dev-db-reset] Fatal error: ${(err as Error).message}`);
    process.exit(1);
  });
}
