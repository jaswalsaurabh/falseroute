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
    process.nextTick(() => {
      this.emit('exit', 0, signal ?? 'SIGTERM');
    });
    return true;
  }

  public simulateExit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }

  public simulateError(err: Error): void {
    this.emit('error', err);
  }
}

test('parseEnvFile parses simple and quoted variables correctly', () => {
  const input = `
# Comment line
NODE_ENV=development
PORT="3000"
OPERATOR_ACCESS_TOKEN='not-a-real-token'
DATABASE_URL=postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public # inline comment
EXPORTED_VAR=test
export ANOTHER_EXPORT="hello\\nworld"
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
});

test('loadEnvironment gives precedence to process.env over file defaults', () => {
  const result = loadEnvironment({
    rootDir: process.cwd(),
    envFile: '.env.example',
    processEnv: {
      PORT: '4000',
      CUSTOM_INJECTED: 'active',
    },
  });

  assert.equal(result.hasEnvFile, true);
  // process.env override
  assert.equal(result.env['PORT'], '4000');
  assert.equal(result.env['CUSTOM_INJECTED'], 'active');
  // file fallback
  assert.equal(result.env['OPERATOR_ACCESS_TOKEN'], 'not-a-real-local-operator-token');
});

test('validateServiceEnvironment validates according to selected services', () => {
  // Web only needs nothing special
  const webValid = validateServiceEnvironment(['web'], {}, true);
  assert.equal(webValid.valid, true);

  // API needs DATABASE_URL and OPERATOR_ACCESS_TOKEN
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

  // Valid API environment
  const apiValid = validateServiceEnvironment(
    ['api'],
    {
      DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/dev',
      OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
    },
    true,
  );
  assert.equal(apiValid.valid, true);

  // Worker needs DATABASE_URL
  const workerInvalid = validateServiceEnvironment(['worker'], {}, true);
  assert.equal(workerInvalid.valid, false);
  assert.equal(
    workerInvalid.errors.some((e) => e.includes('DATABASE_URL')),
    true,
  );
});

test('validateServiceEnvironment rejects invalid DATABASE_URL and short token without leaking values', () => {
  const result = validateServiceEnvironment(
    ['api'],
    {
      DATABASE_URL: 'mysql://invalid-url',
      OPERATOR_ACCESS_TOKEN: 'short',
    },
    true,
  );

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((e) => e.includes('valid postgresql:// connection string')),
    true,
  );
  assert.equal(
    result.errors.some((e) => e.includes('at least 8 characters long')),
    true,
  );
  // Ensure no values are leaked in the error strings
  assert.equal(
    result.errors.some((e) => e.includes('mysql://invalid-url')),
    false,
  );
  assert.equal(
    result.errors.some((e) => e.includes('short')),
    false,
  );
});

test('parseCliArgs parses commands and service options correctly', () => {
  assert.deepEqual(parseCliArgs([]), {
    services: ['web', 'api', 'worker'],
    migrate: false,
    skipBuild: false,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--services=api,worker']), {
    services: ['api', 'worker'],
    migrate: false,
    skipBuild: false,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--services=web', '--no-build']), {
    services: ['web'],
    migrate: false,
    skipBuild: true,
    help: false,
  });

  assert.deepEqual(parseCliArgs(['--migrate']), {
    services: ['web', 'api', 'worker'],
    migrate: true,
    skipBuild: false,
    help: false,
  });

  assert.throws(() => parseCliArgs(['--services=unknown']), /Unknown service/);
  assert.throws(() => parseCliArgs(['--unknown-flag']), /Unknown option/);
});

test('DevSupervisor stops startup if workspace build fails', async () => {
  let exitCode: number | null = null;
  const logs: string[] = [];

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['web'],
    buildFn: () => false, // Build fails
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

test('DevSupervisor terminates sibling services when one child exits unexpectedly', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const isApi = args.includes('@false-route/api');
      const name = isApi ? 'api' : 'worker';
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

  // Simulate unexpected crash of api child with code 2
  apiChild.simulateExit(2);

  // Worker sibling should receive SIGTERM termination
  assert.equal(workerChild.killed, true);
  assert.equal(workerChild.signalSent, 'SIGTERM');

  // Once all children exit, supervisor exits with child's failure exit code
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

  // Send manual stopAll (as SIGINT)
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

test('DevSupervisor handles child startup error event properly', async () => {
  let exitCode: number | null = null;
  const children = new Map<string, FakeChildProcess>();

  const supervisor = new DevSupervisor({
    rootDir: '/fake/root',
    services: ['api', 'worker'],
    skipBuild: true,
    spawnFn: (_cmd, args) => {
      const isApi = args.includes('@false-route/api');
      const name = isApi ? 'api' : 'worker';
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
});

test('validateServiceEnvironment succeeds without .env file if process.env provides all required variables', () => {
  const result = validateServiceEnvironment(
    ['api', 'worker'],
    {
      DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev',
      OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token',
    },
    false, // no .env file
  );

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateServiceEnvironment warns about missing .env file if required variables are missing', () => {
  const result = validateServiceEnvironment(
    ['api'],
    {},
    false, // no .env file
  );

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
  // Valid local migration env without API tokens
  const validMigration = validateMigrationEnvironment(
    {
      DATABASE_URL:
        'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
    },
    true,
  );
  assert.equal(validMigration.valid, true);
  assert.equal(validMigration.errors.length, 0);

  // Missing DATABASE_URL
  const missingDb = validateMigrationEnvironment({}, true);
  assert.equal(missingDb.valid, false);
  assert.equal(
    missingDb.errors.some((e) => e.includes('Missing required environment variable for migration')),
    true,
  );

  // Remote DATABASE_URL rejected for migration
  const remoteDb = validateMigrationEnvironment(
    {
      DATABASE_URL: 'postgresql://falseroute:falseroute@db.example.com:5432/falseroute_dev',
    },
    true,
  );
  assert.equal(remoteDb.valid, false);
  assert.equal(
    remoteDb.errors.some((e) => e.includes('DATABASE_URL must target a local database host')),
    true,
  );

  // Missing .env file warning if DATABASE_URL absent
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
      const isApi = args.includes('@false-route/api');
      const name = isApi ? 'api' : 'worker';
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

  // Simulate unexpected clean exit of api child with code 0
  apiChild.simulateExit(0);

  // Worker sibling should receive SIGTERM termination
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

  // Missing or empty
  assert.equal(validateLocalDatabaseUrl(''), 'Missing required environment variable: DATABASE_URL');
  assert.equal(
    validateLocalDatabaseUrl(undefined),
    'Missing required environment variable: DATABASE_URL',
  );

  // Invalid scheme
  assert.equal(
    validateLocalDatabaseUrl('mysql://localhost:3306/db'),
    'DATABASE_URL must be a valid postgresql:// connection string',
  );

  // Non-local host
  assert.equal(
    validateLocalDatabaseUrl('postgresql://user:pass@rds.amazonaws.com:5432/db'),
    'DATABASE_URL must target a local database host (e.g. localhost, 127.0.0.1) for local development',
  );
});
