import { Client } from 'pg';
import { execSync } from 'node:child_process';
import { validateTestDatabaseUrl } from '../src/test-database.ts';

const targetUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_test?schema=public';

// Validate test database URL safety
const validatedUrl = validateTestDatabaseUrl(targetUrl);
const parsed = new URL(validatedUrl);
const dbName = parsed.pathname.replace(/^\//, '').split('?')[0] ?? 'falseroute_test';

console.log(`[setup-test-db] Target test database: "${dbName}"`);

// Create maintenance connection URL pointing to default development database on same instance
const maintenanceUrl = new URL(validatedUrl);
maintenanceUrl.pathname = '/falseroute_dev';

async function main() {
  const client = new Client({ connectionString: maintenanceUrl.toString() });
  try {
    await client.connect();
    console.log('[setup-test-db] Connected to PostgreSQL instance.');

    const checkRes = await client.query('SELECT 1 FROM pg_database WHERE datname = $1;', [dbName]);

    if (checkRes.rowCount === 0) {
      console.log(`[setup-test-db] Database "${dbName}" does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}";`);
      console.log(`[setup-test-db] Database "${dbName}" created successfully.`);
    } else {
      console.log(`[setup-test-db] Database "${dbName}" already exists.`);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[setup-test-db] Error ensuring database: ${errorMsg}`);
    process.exit(1);
  } finally {
    await client.end();
  }

  // Deploy migrations to the test database
  console.log(`[setup-test-db] Deploying Prisma migrations to "${dbName}"...`);
  try {
    execSync('pnpm --filter @false-route/database migrate:deploy', {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: validatedUrl,
      },
    });
    console.log(`[setup-test-db] Migrations successfully deployed to "${dbName}".`);
  } catch (migErr: unknown) {
    const errorMsg = migErr instanceof Error ? migErr.message : String(migErr);
    console.error(`[setup-test-db] Failed to deploy migrations: ${errorMsg}`);
    process.exit(1);
  }
}

void main();
