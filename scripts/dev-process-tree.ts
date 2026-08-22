import { spawnSync, type ChildProcess } from 'node:child_process';

export type ProcessTreeKill = (child: ChildProcess, signal: NodeJS.Signals | string) => void;

export interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Services are spawned in their own POSIX process group. Signalling the
 * negative group id reaches pnpm and the Vite/tsx descendants it starts.
 * Windows uses taskkill's tree mode, adding /F only after the graceful timeout.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals | string,
  options: ProcessTreeOptions = {},
): void {
  const pid = child.pid;
  const platform = options.platform ?? process.platform;
  const processKill = options.processKill ?? process.kill;

  if (pid && platform !== 'win32') {
    try {
      processKill(-pid, signal as NodeJS.Signals);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }

  if (pid && platform === 'win32') {
    const taskkillArgs = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') taskkillArgs.push('/F');
    const result = spawnSync('taskkill', taskkillArgs, { stdio: 'ignore' });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.error && errorCode !== 'ESRCH') throw result.error;
    return;
  }

  try {
    child.kill(signal as NodeJS.Signals);
  } catch {
    // The child may have exited between the group lookup and the signal.
  }
}
