import assert from 'node:assert/strict';
import test from 'node:test';
import { runSupervisorCli, printHelp, type DevSupervisorOptions } from './dev-supervisor.ts';

test('invalid migration environment exits nonzero and never runs migration or services', async () => {
  let exitCode: number | null = null;
  const errors: string[] = [];
  let migrationRan = false;
  let supervisorStarted = false;

  await runSupervisorCli({
    argv: ['--migrate'],
    loadEnvFn: () => ({ env: {}, hasEnvFile: false, envFilePath: '/dummy/.env' }),
    runMigrationFn: () => {
      migrationRan = true;
      return true;
    },
    startSupervisorFn: async () => {
      supervisorStarted = true;
    },
    logError: (msg) => errors.push(msg),
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(migrationRan, false);
  assert.equal(supervisorStarted, false);
  assert.equal(
    errors.some((e) => e.includes('Migration environment validation failed')),
    true,
  );
});

test('migration command failure exits nonzero and never starts services', async () => {
  let exitCode: number | null = null;
  const errors: string[] = [];
  let migrationRan = false;
  let supervisorStarted = false;

  await runSupervisorCli({
    argv: ['--migrate', '--services=api'],
    loadEnvFn: () => ({
      env: {
        DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
        OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
      },
      hasEnvFile: true,
      envFilePath: '/dummy/.env',
    }),
    runMigrationFn: () => {
      migrationRan = true;
      return false;
    },
    startSupervisorFn: async () => {
      supervisorStarted = true;
    },
    logError: (msg) => errors.push(msg),
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(migrationRan, true);
  assert.equal(supervisorStarted, false);
  assert.equal(
    errors.some((e) => e.includes('Database migration failed. Aborting startup.')),
    true,
  );
});

test('successful bare --migrate exits 0 and never starts services', async () => {
  let exitCode: number | null = null;
  let migrationRan = false;
  let supervisorStarted = false;

  await runSupervisorCli({
    argv: ['--migrate'],
    loadEnvFn: () => ({
      env: {
        DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
      },
      hasEnvFile: true,
      envFilePath: '/dummy/.env',
    }),
    runMigrationFn: () => {
      migrationRan = true;
      return true;
    },
    startSupervisorFn: async () => {
      supervisorStarted = true;
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(migrationRan, true);
  assert.equal(supervisorStarted, false);
});

test('successful --migrate --services=api runs migration first and then starts only API', async () => {
  let exitCode: number | null = null;
  let migrationRan = false;
  let startedServices: string[] | undefined;
  const executionOrder: string[] = [];

  await runSupervisorCli({
    argv: ['--migrate', '--services=api'],
    loadEnvFn: () => ({
      env: {
        DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
        OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
      },
      hasEnvFile: true,
      envFilePath: '/dummy/.env',
    }),
    runMigrationFn: () => {
      migrationRan = true;
      executionOrder.push('migrate');
      return true;
    },
    startSupervisorFn: async (opts: DevSupervisorOptions) => {
      executionOrder.push('supervisor');
      startedServices = opts.services;
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, null);
  assert.equal(migrationRan, true);
  assert.deepEqual(executionOrder, ['migrate', 'supervisor']);
  assert.deepEqual(startedServices, ['api']);
});

test('help text output displays available commands and options accurately', async () => {
  const output: string[] = [];
  printHelp((msg) => output.push(msg));

  const text = output.join('\n');
  assert.equal(text.includes('FalseRoute Local Development Supervisor'), true);
  assert.equal(text.includes('pnpm dev:migrate'), true);
  assert.equal(text.includes('--services=<list>'), true);
  assert.equal(text.includes('--migrate'), true);

  let exitCode: number | null = null;
  const helpOutput: string[] = [];
  await runSupervisorCli({
    argv: ['--help'],
    log: (msg) => helpOutput.push(msg),
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(
    helpOutput.some((t) => t.includes('FalseRoute Local Development Supervisor')),
    true,
  );
});

test('CLI argument parsing errors exit nonzero without starting services or migration', async () => {
  let exitCode: number | null = null;
  const errors: string[] = [];
  let migrationRan = false;
  let supervisorStarted = false;

  await runSupervisorCli({
    argv: ['--invalid-flag'],
    runMigrationFn: () => {
      migrationRan = true;
      return true;
    },
    startSupervisorFn: async () => {
      supervisorStarted = true;
    },
    logError: (msg) => errors.push(msg),
    onExit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(migrationRan, false);
  assert.equal(supervisorStarted, false);
  assert.equal(
    errors.some((e) => e.includes('Unknown option "--invalid-flag"')),
    true,
  );
});
