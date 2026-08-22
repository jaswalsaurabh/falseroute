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
