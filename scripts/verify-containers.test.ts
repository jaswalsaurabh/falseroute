import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDockerAvailable,
  parseImageInspect,
  assertNonRootUser,
  assertNoProhibitedFiles,
  runContainerVerification,
  type DockerCommandRunner,
} from './verify-containers.ts';

const mockSuccessRunner: DockerCommandRunner = () => ({
  status: 0,
  stdout: Buffer.from('{"ServerVersion":"24.0.0"}'),
  stderr: Buffer.from(''),
  pid: 1234,
  output: [],
  signal: null,
});

const mockFailureRunner: DockerCommandRunner = () => ({
  status: 1,
  stdout: Buffer.from(''),
  stderr: Buffer.from('daemon not running'),
  pid: 1234,
  output: [],
  signal: null,
});

const cleanRunner: DockerCommandRunner = () => ({
  status: 0,
  stdout: Buffer.from('CLEAN\n'),
  stderr: Buffer.from(''),
  pid: 1234,
  output: [],
  signal: null,
});

const dirtyRunner: DockerCommandRunner = () => ({
  status: 1,
  stdout: Buffer.from(''),
  stderr: Buffer.from(''),
  pid: 1234,
  output: [],
  signal: null,
});

const mockUnavailableRunner: DockerCommandRunner = () => ({
  status: 1,
  stdout: Buffer.from(''),
  stderr: Buffer.from('Cannot connect to the Docker daemon'),
  pid: 1234,
  output: [],
  signal: null,
});

describe('Container Security & Verification Tooling', () => {
  it('detects when Docker daemon is available or unavailable', () => {
    assert.equal(isDockerAvailable(mockSuccessRunner), true);
    assert.equal(isDockerAvailable(mockFailureRunner), false);
  });

  it('parses Docker inspect JSON configuration accurately', () => {
    const inspectJson = JSON.stringify([
      {
        Config: {
          User: 'node',
          Entrypoint: ['node'],
          Cmd: ['dist/index.js'],
          Env: ['NODE_ENV=production', 'PORT=3000'],
        },
      },
    ]);

    const inspection = parseImageInspect(inspectJson);
    assert.equal(inspection.user, 'node');
    assert.deepEqual(inspection.entrypoint, ['node']);
    assert.deepEqual(inspection.cmd, ['dist/index.js']);
  });

  it('validates non-root user and rejects root or default UID 0', () => {
    assert.doesNotThrow(() => {
      assertNonRootUser('falseroute-api', {
        user: 'node',
        entrypoint: [],
        cmd: [],
        env: [],
      });
    });

    assert.doesNotThrow(() => {
      assertNonRootUser('falseroute-api', {
        user: '10001',
        entrypoint: [],
        cmd: [],
        env: [],
      });
    });

    assert.throws(() => {
      assertNonRootUser('falseroute-api', {
        user: 'root',
        entrypoint: [],
        cmd: [],
        env: [],
      });
    }, /violates non-root policy/);

    assert.throws(() => {
      assertNonRootUser('falseroute-api', {
        user: '0',
        entrypoint: [],
        cmd: [],
        env: [],
      });
    }, /violates non-root policy/);

    assert.throws(() => {
      assertNonRootUser('falseroute-api', {
        user: '',
        entrypoint: [],
        cmd: [],
        env: [],
      });
    }, /violates non-root policy/);
  });

  it('asserts prohibited files (.env, .git, private docs) are absent', () => {
    assert.doesNotThrow(() => {
      assertNoProhibitedFiles('falseroute-api:test', cleanRunner);
    });

    assert.throws(() => {
      assertNoProhibitedFiles('falseroute-api:test', dirtyRunner);
    }, /contains prohibited files/);
  });

  it('fails closed in CI environment if Docker daemon is not available', async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const passed = await runContainerVerification({
      runDocker: mockUnavailableRunner,
      isCi: true,
      log: (msg) => logs.push(msg),
      logError: (msg) => errors.push(msg),
    });

    assert.equal(passed, false);
    assert.ok(errors.some((e) => e.includes('Docker daemon is unavailable in CI')));
  });

  it('cleans up Docker network and ephemeral containers even when verification fails', async () => {
    const commandsRun: string[][] = [];
    const trackingRunner: DockerCommandRunner = (args) => {
      commandsRun.push([...args]);
      if (args[0] === 'info') {
        return {
          status: 0,
          stdout: Buffer.from('{"ServerVersion":"24.0.0"}'),
          stderr: Buffer.from(''),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return {
          status: 0,
          stdout: Buffer.from(JSON.stringify([{ Config: { User: 'node' } }])),
          stderr: Buffer.from(''),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      if (args[0] === 'run' && args.some((a) => a.includes('CLEAN'))) {
        return {
          status: 0,
          stdout: Buffer.from('CLEAN'),
          stderr: Buffer.from(''),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      if (args[0] === 'network' && args[1] === 'create') {
        return {
          status: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('network create failed'),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        pid: 1,
        output: [],
        signal: null,
      };
    };

    const logs: string[] = [];
    const errors: string[] = [];

    const passed = await runContainerVerification({
      runDocker: trackingRunner,
      skipBuild: true,
      log: (msg) => logs.push(msg),
      logError: (msg) => errors.push(msg),
    });

    assert.equal(passed, false);
    assert.ok(commandsRun.some((cmd) => cmd[0] === 'network' && cmd[1] === 'rm'));
    assert.ok(commandsRun.some((cmd) => cmd[0] === 'rm' && cmd[1] === '-f'));
  });
});
