import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  loadEnvironment,
  parseCliArgs,
  validateMigrationEnvironment,
  validateServiceEnvironment,
} from './dev-supervisor-environment.ts';
import type { ParsedCliArgs } from './dev-supervisor-environment.ts';
import { terminateProcessTree, type ProcessTreeKill } from './dev-process-tree.ts';

export {
  loadEnvironment,
  parseEnvFile,
  parseCliArgs,
  validateLocalDatabaseUrl,
  validateMigrationEnvironment,
  validateServiceEnvironment,
} from './dev-supervisor-environment.ts';
export type {
  LoadedEnvResult,
  ParsedCliArgs,
  ValidationResult,
} from './dev-supervisor-environment.ts';

export type ServiceKey = 'web' | 'api' | 'worker';

export interface ServiceDefinition {
  key: ServiceKey;
  name: string;
  color: string;
  command: string;
  args: string[];
  requiredEnvVars: string[];
}

export const KNOWN_SERVICES: Record<ServiceKey, ServiceDefinition> = {
  web: {
    key: 'web',
    name: 'web',
    color: '\x1b[36m', // Cyan
    command: 'pnpm',
    args: ['--filter', '@false-route/web', 'dev'],
    requiredEnvVars: [],
  },
  api: {
    key: 'api',
    name: 'api',
    color: '\x1b[32m', // Green
    command: 'pnpm',
    args: ['--filter', '@false-route/api', 'dev'],
    requiredEnvVars: ['DATABASE_URL', 'OPERATOR_ACCESS_TOKEN'],
  },
  worker: {
    key: 'worker',
    name: 'worker',
    color: '\x1b[35m', // Magenta
    command: 'pnpm',
    args: ['--filter', '@false-route/worker', 'dev'],
    requiredEnvVars: ['DATABASE_URL'],
  },
};

const RESET_COLOR = '\x1b[0m';
const SUPERVISOR_COLOR = '\x1b[33m'; // Yellow

export type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
export type BuildFunction = (rootDir: string) => boolean;

export interface DevSupervisorOptions {
  rootDir: string;
  services?: ServiceKey[] | undefined;
  env?: Record<string, string> | undefined;
  skipBuild?: boolean | undefined;
  spawnFn?: SpawnFunction | undefined;
  buildFn?: BuildFunction | undefined;
  log?: ((message: string) => void) | undefined;
  logError?: ((message: string) => void) | undefined;
  onExit?: ((code: number) => void) | undefined;
  gracefulTimeoutMs?: number | undefined;
  processTreeKillFn?: ProcessTreeKill | undefined;
}

export class DevSupervisor {
  private readonly rootDir: string;
  private readonly services: ServiceKey[];
  private readonly env: Record<string, string>;
  private readonly skipBuild: boolean;
  private readonly spawnFn: SpawnFunction;
  private readonly buildFn: BuildFunction;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;
  private readonly onExit: (code: number) => void;
  private readonly gracefulTimeoutMs: number;
  private readonly processTreeKillFn: ProcessTreeKill;

  private readonly activeProcesses = new Map<ServiceKey, ChildProcess>();
  private readonly completedServices = new Set<ServiceKey>();
  private isShuttingDown = false;
  private exitCode = 0;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private exitNotified = false;

  constructor(options: DevSupervisorOptions) {
    this.rootDir = options.rootDir;
    this.services = options.services !== undefined ? options.services : ['web', 'api', 'worker'];
    this.env = options.env ?? {};
    this.skipBuild = options.skipBuild ?? false;
    this.spawnFn = options.spawnFn ?? spawn;
    this.buildFn =
      options.buildFn ??
      ((rootDir: string) => {
        const res = spawnSync('pnpm', ['build'], {
          cwd: rootDir,
          env: process.env,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        return res.status === 0;
      });
    this.log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
    this.logError = options.logError ?? ((msg: string) => process.stderr.write(`${msg}\n`));
    this.onExit = options.onExit ?? ((code: number) => process.exit(code));
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000;
    this.processTreeKillFn = options.processTreeKillFn ?? terminateProcessTree;
  }

  private formatLog(prefix: string, color: string, text: string): string {
    const isTTY = Boolean(process.stdout.isTTY);
    const colorStart = isTTY ? color : '';
    const colorEnd = isTTY ? RESET_COLOR : '';
    return `${colorStart}[${prefix}]${colorEnd} ${text}`;
  }

  public async start(): Promise<void> {
    if (!this.skipBuild) {
      this.log(
        this.formatLog('supervisor', SUPERVISOR_COLOR, 'Building workspace dependencies...'),
      );
      const buildOk = this.buildFn(this.rootDir);
      if (!buildOk) {
        this.logError(
          this.formatLog(
            'supervisor',
            SUPERVISOR_COLOR,
            'Workspace build failed. Services will not be started.',
          ),
        );
        this.onExit(1);
        return;
      }
    }

    if (this.services.length === 0) {
      this.log(this.formatLog('supervisor', SUPERVISOR_COLOR, 'No services selected to start.'));
      this.onExit(0);
      return;
    }

    this.log(
      this.formatLog(
        'supervisor',
        SUPERVISOR_COLOR,
        `Starting services: ${this.services.join(', ')}`,
      ),
    );

    for (const serviceKey of this.services) {
      if (this.isShuttingDown) break;
      const def = KNOWN_SERVICES[serviceKey];
      try {
        const child = this.spawnFn(def.command, def.args, {
          cwd: this.rootDir,
          env: {
            ...process.env,
            ...this.env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          shell: process.platform === 'win32',
        });

        this.activeProcesses.set(serviceKey, child);
        this.attachOutput(serviceKey, def, child);
        this.attachLifecycle(serviceKey, child);
      } catch (err) {
        this.logError(
          this.formatLog(
            'supervisor',
            SUPERVISOR_COLOR,
            `Failed to start service "${serviceKey}": ${(err as Error).message}`,
          ),
        );
        this.exitCode = 1;
        this.stopAll('SIGTERM');
        break;
      }
    }
  }

  private attachOutput(key: ServiceKey, def: ServiceDefinition, child: ChildProcess): void {
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        this.log(this.formatLog(def.name, def.color, line));
      });
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        this.logError(this.formatLog(def.name, def.color, line));
      });
    }
  }

  private attachLifecycle(key: ServiceKey, child: ChildProcess): void {
    child.on('error', (err) => {
      this.logError(
        this.formatLog(
          'supervisor',
          SUPERVISOR_COLOR,
          `Failed to spawn service "${key}": ${err.message}`,
        ),
      );
      this.exitCode = 1;
      this.stopAll('SIGTERM');
    });

    child.on('exit', (code, signal) => {
      this.activeProcesses.delete(key);
      this.completedServices.add(key);

      if (!this.isShuttingDown) {
        if (code !== null && code !== 0) {
          this.logError(
            this.formatLog(
              'supervisor',
              SUPERVISOR_COLOR,
              `Service "${key}" exited unexpectedly with code ${code}. Terminating siblings...`,
            ),
          );
          this.exitCode = code;
          this.stopAll('SIGTERM');
        } else if (signal !== null) {
          this.log(
            this.formatLog(
              'supervisor',
              SUPERVISOR_COLOR,
              `Service "${key}" terminated by signal ${signal}. Terminating siblings...`,
            ),
          );
          this.exitCode = 1;
          this.stopAll('SIGTERM');
        } else {
          this.log(
            this.formatLog(
              'supervisor',
              SUPERVISOR_COLOR,
              `Service "${key}" exited unexpectedly with code 0. Terminating siblings...`,
            ),
          );
          this.exitCode = 1;
          this.stopAll('SIGTERM');
        }
      }

      this.checkAllCompleted();
    });
  }

  public stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.isShuttingDown && this.activeProcesses.size === 0) return;
    this.isShuttingDown = true;

    for (const [key, child] of this.activeProcesses) {
      try {
        this.processTreeKillFn(child, signal);
      } catch (err) {
        this.logError(
          this.formatLog(
            'supervisor',
            SUPERVISOR_COLOR,
            `Error stopping service "${key}": ${(err as Error).message}`,
          ),
        );
      }
    }

    if (!this.shutdownTimer && this.activeProcesses.size > 0) {
      this.shutdownTimer = setTimeout(() => {
        if (this.activeProcesses.size > 0) {
          this.logError(
            this.formatLog(
              'supervisor',
              SUPERVISOR_COLOR,
              'Graceful shutdown timeout exceeded. Forcing termination (SIGKILL)...',
            ),
          );
          for (const child of this.activeProcesses.values()) {
            try {
              this.processTreeKillFn(child, 'SIGKILL');
            } catch {
              // Ignore forced kill failures
            }
          }
          this.activeProcesses.clear();
          this.checkAllCompleted();
        }
      }, this.gracefulTimeoutMs);

      if (typeof this.shutdownTimer.unref === 'function') {
        this.shutdownTimer.unref();
      }
    }

    this.checkAllCompleted();
  }

  private checkAllCompleted(): void {
    if (this.isShuttingDown && this.activeProcesses.size === 0 && !this.exitNotified) {
      this.exitNotified = true;
      if (this.shutdownTimer) {
        clearTimeout(this.shutdownTimer);
        this.shutdownTimer = null;
      }
      this.onExit(this.exitCode);
    }
  }
}

export function printHelp(write: (text: string) => void = (t) => process.stdout.write(t)): void {
  const helpText = `
FalseRoute Local Development Supervisor

Usage:
  pnpm dev                         Start all services (web, api, worker)
  pnpm dev:web                     Start React operator dashboard only
  pnpm dev:api                     Start Express control-plane API only
  pnpm dev:worker                  Start Asynchronous Worker only
  pnpm dev:services                Start API and Worker concurrently
  pnpm dev:migrate                 Run development database migrations safely

Options:
  --services=<list>                Comma-separated list of services (web,api,worker)
  --env-file=<path>                Path to environment file (default: .env)
  --no-build, --skip-build         Skip workspace build before starting services
  --migrate                        Run migrations only unless --services is also supplied
  --help, -h                       Display this help message
`;
  write(`${helpText}\n`);
}

export function runMigration(rootDir: string, env: Record<string, string>): boolean {
  const isTTY = Boolean(process.stdout.isTTY);
  const colorStart = isTTY ? SUPERVISOR_COLOR : '';
  const colorEnd = isTTY ? RESET_COLOR : '';
  process.stdout.write(
    `${colorStart}[supervisor]${colorEnd} Running safe development database migration...\n`,
  );

  const res = spawnSync('node', ['../../scripts/prisma-guard.ts', 'migrate', 'deploy'], {
    cwd: resolve(rootDir, 'packages/database'),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  return res.status === 0;
}

export interface SupervisorCliOptions {
  argv?: string[] | undefined;
  rootDir?: string | undefined;
  loadEnvFn?: typeof loadEnvironment | undefined;
  runMigrationFn?: ((rootDir: string, env: Record<string, string>) => boolean) | undefined;
  startSupervisorFn?: ((options: DevSupervisorOptions) => Promise<void>) | undefined;
  log?: ((message: string) => void) | undefined;
  logError?: ((message: string) => void) | undefined;
  onExit?: ((code: number) => void) | undefined;
}

export async function runSupervisorCli(options: SupervisorCliOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const argv = options.argv ?? process.argv.slice(2);
  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const logError = options.logError ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const loadEnv = options.loadEnvFn ?? loadEnvironment;
  const runMigrate = options.runMigrationFn ?? runMigration;
  const startSupervisor =
    options.startSupervisorFn ??
    (async (opts: DevSupervisorOptions) => {
      const supervisor = new DevSupervisor(opts);
      const onSignal = (signal: NodeJS.Signals) => {
        supervisor.stopAll(signal);
      };
      process.on('SIGINT', () => onSignal('SIGINT'));
      process.on('SIGTERM', () => onSignal('SIGTERM'));
      await supervisor.start();
    });

  let cliArgs: ParsedCliArgs;
  try {
    cliArgs = parseCliArgs(argv);
  } catch (err) {
    logError(`[supervisor] CLI Error: ${(err as Error).message}`);
    onExit(1);
    return;
  }

  if (cliArgs.help) {
    printHelp(log);
    onExit(0);
    return;
  }

  const { env, hasEnvFile } = loadEnv({
    rootDir,
    envFile: cliArgs.envFile,
  });

  if (cliArgs.migrate) {
    const migrationValidation = validateMigrationEnvironment(env, hasEnvFile);
    if (!migrationValidation.valid) {
      logError('[supervisor] Migration environment validation failed:');
      for (const err of migrationValidation.errors) {
        logError(`  - ${err}`);
      }
      onExit(1);
      return;
    }

    const migrationOk = runMigrate(rootDir, env);
    if (!migrationOk) {
      logError('[supervisor] Database migration failed. Aborting startup.');
      onExit(1);
      return;
    }

    if (!cliArgs.hasExplicitServices) {
      onExit(0);
      return;
    }
  }

  const validation = validateServiceEnvironment(cliArgs.services, env, hasEnvFile);
  if (!validation.valid) {
    logError('[supervisor] Environment validation failed:');
    for (const err of validation.errors) {
      logError(`  - ${err}`);
    }
    onExit(1);
    return;
  }

  await startSupervisor({
    rootDir,
    services: cliArgs.services,
    env,
    skipBuild: cliArgs.skipBuild,
    log,
    logError,
    onExit,
    gracefulTimeoutMs: 5000,
  });
}

export async function main(): Promise<void> {
  await runSupervisorCli();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[supervisor] Fatal error: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
