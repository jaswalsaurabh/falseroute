import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  parseEnvFile,
  loadEnvironment,
  validateServiceEnvironment,
  validateMigrationEnvironment,
  validateLocalDatabaseUrl,
  parseCliArgs,
  DevSupervisor,
} from './dev-supervisor.ts';

class FakeChildProcess extends EventEmitter {
  public killed = false;
  public signalSent: string | null = null;
  public stdout = new PassThrough();
  public stderr = new PassThrough();

  public kill(signal?: NodeJS.Signals | string): boolean {
    this.killed = true;
    this.signalSent = signal ?? 'SIGTERM';
    process.nextTick(() => this.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  }
  public simulateExit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }
  public simulateError(err: Error): void {
    this.emit('error', err);
  }
}

test('parseEnvFile parses simple, quoted, and commented variables correctly', () => {
  const input = `
# Comment line
NODE_ENV=development
PORT="3000"
OPERATOR_ACCESS_TOKEN='not-a-real-token'
DATABASE_URL=postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public # inline comment
EXPORTED_VAR=test
export ANOTHER_EXPORT="hello\\nworld" # trailing comment
QUOTED_WITH_HASH="pass#word" # real comment
SINGLE_QUOTED_WITH_HASH='pass#word2' # real comment 2
`;

  const parsed = parseEnvFile(input);
  assert.equal(parsed['NODE_ENV'], 'development');
  assert.equal(parsed['PORT'], '3000');
  assert.equal(parsed['OPERATOR_ACCESS_TOKEN'], 'not-a-real-token');
  assert.equal(
    parsed['DATABASE_URL'],
    'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
  );
  assert.equal(parsed['EXPORTED_VAR'], 'test');
  assert.equal(parsed['ANOTHER_EXPORT'], 'hello\nworld');
  assert.equal(parsed['QUOTED_WITH_HASH'], 'pass#word');
  assert.equal(parsed['SINGLE_QUOTED_WITH_HASH'], 'pass#word2');
});

test('loadEnvironment gives precedence to process.env over file defaults', () => {
  const result = loadEnvironment({
    rootDir: process.cwd(),
    envFile: '.env.example',
    processEnv: { PORT: '4000', CUSTOM_INJECTED: 'active' },
  });

  assert.equal(result.hasEnvFile, true);
  assert.equal(result.env['PORT'], '4000');
  assert.equal(result.env['CUSTOM_INJECTED'], 'active');
  assert.equal(result.env['OPERATOR_ACCESS_TOKEN'], 'not-a-real-local-operator-token');
});

test('validateServiceEnvironment validates according to selected services and deduplicates errors', () => {
  const webValid = validateServiceEnvironment(['web'], {}, true);
  assert.equal(webValid.valid, true);

  const apiInvalid = validateServiceEnvironment(['api'], {}, true);
  assert.equal(apiInvalid.valid, false);
  assert.equal(
    apiInvalid.errors.some((e) => e.includes('DATABASE_URL')),
    true,
  );
  assert.equal(
    apiInvalid.errors.some((e) => e.includes('OPERATOR_ACCESS_TOKEN')),
    true,
  );

  const apiValid = validateServiceEnvironment(
    ['api'],
    {
      DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
      OPERATOR_ACCESS_TOKEN: 'not-a-real-secret-token',
    },
    true,
  );
  assert.equal(apiValid.valid, true);

  const workerInvalid = validateServiceEnvironment(['worker'], {}, true);
  assert.equal(workerInvalid.valid, false);
  assert.equal(workerInvalid.errors.length, 1);
  assert.equal(workerInvalid.errors[0]?.includes('DATABASE_URL'), true);

  const bothInvalid = validateServiceEnvironment(['api', 'worker'], {}, true);
  assert.equal(bothInvalid.valid, false);
  assert.equal(bothInvalid.errors.length, 3);
});

test('validateServiceEnvironment rejects invalid DATABASE_URL and short token without leaking values', () => {
  const result = validateServiceEnvironment(
    ['api'],
    { DATABASE_URL: 'mysql://localhost:3306/db', OPERATOR_ACCESS_TOKEN: 'short' },
    true,
  );

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0]?.includes('must be a valid postgresql://'), true);
  assert.equal(result.errors[1]?.includes('must be at least 8 characters'), true);
  assert.equal(
    result.errors.some((e) => e.includes('short') || e.includes('mysql://localhost:3306/db')),
    false,
  );
});

test('parseCliArgs parses commands and options correctly and tracks explicit services', () => {
  assert.deepEqual(parseCliArgs([]), {
    services: ['web', 'api', 'worker'],
    hasExplicitServices: false,
    migrate: false,
    skipBuild: false,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--migrate']), {
    services: ['web', 'api', 'worker'],
    hasExplicitServices: false,
    migrate: true,
    skipBuild: false,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--migrate', '--services=api']), {
    services: ['api'],
    hasExplicitServices: true,
    migrate: true,
    skipBuild: false,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--services=api,worker', '--env-file=.env.local']), {
    services: ['api', 'worker'],
    hasExplicitServices: true,
    migrate: false,
    skipBuild: false,
    envFile: '.env.local',
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--services=web', '--no-build']), {
    services: ['web'],
    hasExplicitServices: true,
    migrate: false,
    skipBuild: true,
    help: false,
  });

  assert.throws(() => parseCliArgs(['--services=unknown']), /Unknown service/);
  assert.throws(() => parseCliArgs(['--services=']), /At least one valid service/);
  assert.throws(() => parseCliArgs(['--env-file=']), /A path must be specified/);
  assert.throws(() => parseCliArgs(['--unknown-flag']), /Unknown option/);
});

test('DevSupervisor stops startup if workspace build fails', async () => {
  let exitCode: number | null = null;
  const logs: string[] = [];

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['web'],
    buildFn: () => false,
    spawnFn: () => {
      throw new Error('Should not spawn if build fails');
    },
    log: (msg) => logs.push(msg),
    logError: (msg) => logs.push(msg),
    onExit: (code) => {
      exitCode = code;
    },
  });

  await supervisor.start();
  assert.equal(exitCode, 1);
  assert.equal(
    logs.some((l) => l.includes('Workspace build failed')),
    true,
  );
});

test('DevSupervisor handles empty service selection without starting default services', async () => {
  let exitCode: number | null = null;
  const spawned: string[] = [];

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: [],
    skipBuild: true,
    spawnFn: (cmd) => {
      spawned.push(cmd);
      return new FakeChildProcess() as unknown as ChildProcess;
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  await supervisor.start();
  assert.equal(spawned.length, 0);
  assert.equal(exitCode, 0);
});

test('DevSupervisor terminates sibling services when one child exits unexpectedly', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const name = args.includes('@false-route/api') ? 'api' : 'worker';
      const fake = new FakeChildProcess();
      children.set(name, fake);
      return fake as unknown as ChildProcess;
    },
    onExit: (code) => {
      exitCode = code;
    },
    gracefulTimeoutMs: 100,
  });

  await supervisor.start();
  assert.equal(children.size, 2);
  const apiChild = children.get('api')!;
  const workerChild = children.get('worker')!;

  apiChild.simulateExit(2);
  assert.equal(workerChild.killed, true);
  assert.equal(workerChild.signalSent, 'SIGTERM');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exitCode, 2);
});

test('DevSupervisor forwards SIGINT/SIGTERM cleanly to all running services', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['web', 'api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const isWeb = args.includes('@false-route/web');
      const isApi = args.includes('@false-route/api');
      const name = isWeb ? 'web' : isApi ? 'api' : 'worker';
      const fake = new FakeChildProcess();
      children.set(name, fake);
      return fake as unknown as ChildProcess;
    },
    onExit: (code) => {
      exitCode = code;
    },
    gracefulTimeoutMs: 100,
  });

  await supervisor.start();
  assert.equal(children.size, 3);

  supervisor.stopAll('SIGINT');
  for (const child of children.values()) {
    assert.equal(child.killed, true);
    assert.equal(child.signalSent, 'SIGINT');
  }

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exitCode, 0);
});

test('supervisor forcefully terminates a process tree after graceful timeout', async () => {
  const signals: string[] = [];
  let exitCode: number | null = null;
  const child = new FakeChildProcess();
  child.kill = () => true;

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['web'],
    skipBuild: true,
    spawnFn: () => child as unknown as ChildProcess,
    processTreeKillFn: (_child, signal) => signals.push(signal),
    onExit: (code) => {
      exitCode = code;
    },
    gracefulTimeoutMs: 10,
  });

  await supervisor.start();
  supervisor.stopAll('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(exitCode, 0);
});

test('DevSupervisor handles child startup error event and synchronous spawn throw properly', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const name = args.includes('@false-route/api') ? 'api' : 'worker';
      const fake = new FakeChildProcess();
      children.set(name, fake);
      return fake as unknown as ChildProcess;
    },
    onExit: (code) => {
      exitCode = code;
    },
    gracefulTimeoutMs: 100,
  });

  await supervisor.start();
  const apiChild = children.get('api')!;
  const workerChild = children.get('worker')!;

  apiChild.simulateError(new Error('ENOENT: spawn failed'));
  assert.equal(workerChild.killed, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exitCode, 1);

  // Synchronous spawn throw
  let syncExitCode: number | null = null;
  const syncSupervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api'],
    skipBuild: true,
    spawnFn: () => {
      throw new Error('EACCES permission denied');
    },
    onExit: (code) => {
      syncExitCode = code;
    },
  });
  await syncSupervisor.start();
  assert.equal(syncExitCode, 1);
});

test('validateServiceEnvironment succeeds without .env file if process.env provides all required variables', () => {
  const result = validateServiceEnvironment(
    ['api', 'worker'],
    {
      DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
      OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
    },
    false,
  );

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateServiceEnvironment warns about missing .env file if required variables are missing', () => {
  const result = validateServiceEnvironment(['api'], {}, false);
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((e) => e.includes('Environment file .env was not found')),
    true,
  );
});

test('validateServiceEnvironment rejects non-local DATABASE_URL targets', () => {
  const result = validateServiceEnvironment(
    ['api'],
    {
      DATABASE_URL:
        'postgresql://falseroute:falseroute@remote-db.production.aws.com:5432/falseroute',
      OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
    },
    true,
  );

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((e) => e.includes('DATABASE_URL must target a local database host')),
    true,
  );
});

test('validateMigrationEnvironment validates DATABASE_URL independently of API requirements', () => {
  const validMigration = validateMigrationEnvironment(
    {
      DATABASE_URL:
        'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
    },
    true,
  );
  assert.equal(validMigration.valid, true);

  const missingDb = validateMigrationEnvironment({}, true);
  assert.equal(missingDb.valid, false);
  assert.equal(
    missingDb.errors.some((e) => e.includes('Missing required environment variable for migration')),
    true,
  );

  const remoteDb = validateMigrationEnvironment(
    { DATABASE_URL: 'postgresql://falseroute:falseroute@db.example.com:5432/falseroute_dev' },
    true,
  );
  assert.equal(remoteDb.valid, false);
  assert.equal(
    remoteDb.errors.some((e) => e.includes('DATABASE_URL must target a local database host')),
    true,
  );

  const noEnv = validateMigrationEnvironment({}, false);
  assert.equal(noEnv.valid, false);
  assert.equal(
    noEnv.errors.some((e) => e.includes('Environment file .env was not found')),
    true,
  );
});

test('DevSupervisor terminates sibling services when one child exits cleanly (code 0) unexpectedly', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const name = args.includes('@false-route/api') ? 'api' : 'worker';
      const fake = new FakeChildProcess();
      children.set(name, fake);
      return fake as unknown as ChildProcess;
    },
    onExit: (code) => {
      exitCode = code;
    },
    gracefulTimeoutMs: 100,
  });

  await supervisor.start();
  assert.equal(children.size, 2);
  const apiChild = children.get('api')!;
  const workerChild = children.get('worker')!;

  apiChild.simulateExit(0);
  assert.equal(workerChild.killed, true);
  assert.equal(workerChild.signalSent, 'SIGTERM');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exitCode, 1);
});

test('validateLocalDatabaseUrl accurately validates local host targets and rejects invalid or remote URLs', () => {
  assert.equal(validateLocalDatabaseUrl('postgresql://user:pass@localhost:5432/db'), null);
  assert.equal(validateLocalDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/db'), null);
  assert.equal(validateLocalDatabaseUrl('postgresql://user:pass@[::1]:5432/db'), null);
  assert.equal(validateLocalDatabaseUrl('postgresql://user:pass@0.0.0.0:5432/db'), null);
  assert.equal(
    validateLocalDatabaseUrl('postgresql://user:pass@host.docker.internal:5432/db'),
    null,
  );

  assert.equal(validateLocalDatabaseUrl(''), 'Missing required environment variable: DATABASE_URL');
  assert.equal(
    validateLocalDatabaseUrl(undefined),
    'Missing required environment variable: DATABASE_URL',
  );
  assert.equal(
    validateLocalDatabaseUrl('mysql://localhost:3306/db'),
    'DATABASE_URL must be a valid postgresql:// connection string',
  );
  assert.equal(
    validateLocalDatabaseUrl('postgresql://user:pass@rds.amazonaws.com:5432/db'),
    'DATABASE_URL must target a local database host (e.g. localhost, 127.0.0.1) for local development',
  );
});
