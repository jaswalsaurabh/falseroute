import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import {
  validatePrismaCommand,
  resolvePnpmExecutable,
  executePrismaCommand,
} from './prisma-guard.ts';

test('allows non-destructive Prisma commands', () => {
  assert.equal(validatePrismaCommand(['validate']).allowed, true);
  assert.equal(validatePrismaCommand(['generate']).allowed, true);
  assert.equal(validatePrismaCommand(['migrate', 'status']).allowed, true);
  assert.equal(validatePrismaCommand(['migrate', 'deploy']).allowed, true);
});

test('requires create-only when creating a development migration', () => {
  assert.deepEqual(validatePrismaCommand(['migrate', 'dev']), {
    allowed: false,
    reason: 'migrate dev requires --create-only.',
  });
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--name', 'add_event']).allowed,
    true,
  );
});

test('blocks reset, direct database commands, destructive flags, and unknown commands', () => {
  assert.equal(validatePrismaCommand(['migrate', 'reset']).allowed, false);
  assert.equal(validatePrismaCommand(['db', 'push']).allowed, false);
  assert.equal(validatePrismaCommand(['db', 'execute']).allowed, false);
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--force-reset']).allowed,
    false,
  );
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--force-reset=true']).allowed,
    false,
  );
  assert.equal(validatePrismaCommand(['studio']).allowed, false);
});

test('resolvePnpmExecutable selects pnpm.cmd on Windows and pnpm on POSIX', () => {
  assert.equal(resolvePnpmExecutable('win32'), 'pnpm.cmd');
  assert.equal(resolvePnpmExecutable('linux'), 'pnpm');
  assert.equal(resolvePnpmExecutable('darwin'), 'pnpm');
});

test('executePrismaCommand preserves exact argument boundaries and disables shell execution', () => {
  const spawnedCalls: Array<{
    command: string;
    args: readonly string[];
    options: SpawnSyncOptions;
  }> = [];

  const mockSpawn = (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ): SpawnSyncReturns<Buffer | string> => {
    spawnedCalls.push({ command, args, options });
    return {
      pid: 1234,
      output: [],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    };
  };

  // 1. Windows execution
  const winCode = executePrismaCommand({
    platform: 'win32',
    prismaArgs: ['migrate', 'deploy'],
    spawnSyncFn: mockSpawn,
  });

  assert.equal(winCode, 0);
  assert.equal(spawnedCalls.length, 1);
  assert.equal(spawnedCalls[0]?.command, 'pnpm.cmd');
  assert.deepEqual(spawnedCalls[0]?.args, [
    '--filter',
    '@false-route/database',
    'exec',
    'prisma',
    'migrate',
    'deploy',
  ]);
  assert.equal(spawnedCalls[0]?.options.shell, false);

  // 2. POSIX execution
  const posixCode = executePrismaCommand({
    platform: 'linux',
    prismaArgs: ['validate'],
    spawnSyncFn: mockSpawn,
  });

  assert.equal(posixCode, 0);
  assert.equal(spawnedCalls.length, 2);
  assert.equal(spawnedCalls[1]?.command, 'pnpm');
  assert.deepEqual(spawnedCalls[1]?.args, [
    '--filter',
    '@false-route/database',
    'exec',
    'prisma',
    'validate',
  ]);
  assert.equal(spawnedCalls[1]?.options.shell, false);
});

test('executePrismaCommand returns nonzero exit status on execution error or failure', () => {
  const statusCode = executePrismaCommand({
    platform: 'linux',
    prismaArgs: ['migrate', 'deploy'],
    spawnSyncFn: () => ({
      pid: 1234,
      output: [],
      stdout: '',
      stderr: 'Database unreachable',
      status: 1,
      signal: null,
    }),
  });

  assert.equal(statusCode, 1);
});

test('executePrismaCommand handles ENOENT with bounded static error and prevents secret disclosure', () => {
  const loggedErrors: string[] = [];
  const enoentErr = Object.assign(
    new Error(
      'spawn pnpm ENOENT with env DATABASE_URL=postgresql://dummy-user:dummy-pass@remote-example.invalid:5432/dummy_db',
    ),
    { name: 'ENOENT', code: 'ENOENT' },
  );

  const code = executePrismaCommand({
    platform: 'win32',
    prismaArgs: ['validate'],
    spawnSyncFn: () => ({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: enoentErr,
    }),
    logError: (msg) => loggedErrors.push(msg),
    env: { SENSITIVE_TOKEN: 'not-a-real-secret-token' },
  });

  assert.equal(code, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0], 'Unable to run Prisma: ENOENT');
  assert.equal(
    loggedErrors.some((e) => e.includes('dummy') || e.includes('token')),
    false,
  );
});

test('executePrismaCommand blocks prohibited destructive commands before spawning', () => {
  let wasSpawned = false;
  const loggedErrors: string[] = [];

  const code = executePrismaCommand({
    platform: 'linux',
    prismaArgs: ['migrate', 'reset'],
    spawnSyncFn: () => {
      wasSpawned = true;
      throw new Error('Should not spawn');
    },
    logError: (msg) => loggedErrors.push(msg),
  });

  assert.equal(code, 2);
  assert.equal(wasSpawned, false);
  assert.equal(
    loggedErrors.some((e) => e.includes('Prisma command blocked')),
    true,
  );
});
