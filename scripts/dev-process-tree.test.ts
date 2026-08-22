import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { terminateProcessTree } from './dev-process-tree.ts';

test('process-tree termination targets the complete POSIX process group', () => {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const child = { pid: 12345, kill: () => true } as unknown as ChildProcess;

  terminateProcessTree(child, 'SIGTERM', {
    platform: 'linux',
    processKill: (pid, signal) => signals.push({ pid, signal }),
  });

  assert.deepEqual(signals, [{ pid: -12345, signal: 'SIGTERM' }]);
});

test('process-tree termination on Windows invokes taskkill and succeeds on status 0', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let childKillCalled = false;
  const child = {
    pid: 54321,
    kill: () => {
      childKillCalled = true;
      return true;
    },
  } as unknown as ChildProcess;

  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return { status: 0, signal: null };
    },
  });

  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/PID', '54321', '/T'] }]);
  assert.equal(childKillCalled, false);
});

test('process-tree termination on Windows includes /F flag for SIGKILL', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const child = { pid: 54321, kill: () => true } as unknown as ChildProcess;

  terminateProcessTree(child, 'SIGKILL', {
    platform: 'win32',
    spawnSync: (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return { status: 0, signal: null };
    },
  });

  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/PID', '54321', '/T', '/F'] }]);
});

test('process-tree termination on Windows falls back to child.kill on nonzero exit status', () => {
  let fallbackKilled = false;
  let signalSent = '';
  const child = {
    pid: 54321,
    kill: (sig: NodeJS.Signals | string) => {
      fallbackKilled = true;
      signalSent = String(sig);
      return true;
    },
  } as unknown as ChildProcess;

  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: () => ({ status: 1, signal: null }),
  });

  assert.equal(fallbackKilled, true);
  assert.equal(signalSent, 'SIGTERM');
});

test('process-tree termination on Windows falls back to child.kill on null or undefined status', () => {
  let fallbackKilled = false;
  const child = {
    pid: 54321,
    kill: () => {
      fallbackKilled = true;
      return true;
    },
  } as unknown as ChildProcess;

  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: () => ({ status: null }),
  });
  assert.equal(fallbackKilled, true);

  fallbackKilled = false;
  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: () => ({ status: undefined }),
  });
  assert.equal(fallbackKilled, true);
});

test('process-tree termination on Windows falls back to child.kill on ENOENT/ESRCH spawn errors', () => {
  let fallbackKilled = false;
  const child = {
    pid: 54321,
    kill: () => {
      fallbackKilled = true;
      return true;
    },
  } as unknown as ChildProcess;

  const enoentErr = new Error('spawn taskkill ENOENT') as NodeJS.ErrnoException;
  enoentErr.code = 'ENOENT';

  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: () => ({ error: enoentErr }),
  });
  assert.equal(fallbackKilled, true);
});

test('process-tree termination on Windows re-throws unexpected spawn errors', () => {
  const child = { pid: 54321, kill: () => true } as unknown as ChildProcess;
  const unexpectedErr = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  unexpectedErr.code = 'EACCES';

  assert.throws(
    () =>
      terminateProcessTree(child, 'SIGTERM', {
        platform: 'win32',
        spawnSync: () => ({ error: unexpectedErr }),
      }),
    /EACCES/,
  );
});

test('process-tree termination falls back to child.kill on ESRCH or when pid is undefined', () => {
  let fallbackKilled = false;
  let signalReceived = '';

  const childWithoutPid = {
    pid: undefined,
    kill: (sig: NodeJS.Signals | string) => {
      fallbackKilled = true;
      signalReceived = String(sig);
      return true;
    },
  } as unknown as ChildProcess;

  terminateProcessTree(childWithoutPid, 'SIGINT', {
    platform: 'linux',
  });

  assert.equal(fallbackKilled, true);
  assert.equal(signalReceived, 'SIGINT');

  // Test ESRCH fallback
  let esrchFallback = false;
  const childWithEsrch = {
    pid: 99999,
    kill: () => {
      esrchFallback = true;
      return true;
    },
  } as unknown as ChildProcess;

  terminateProcessTree(childWithEsrch, 'SIGTERM', {
    platform: 'linux',
    processKill: () => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    },
  });

  assert.equal(esrchFallback, true);
});
