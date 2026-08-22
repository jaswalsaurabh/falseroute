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
    this.services = options.services ?? ['web', 'api', 'worker'];
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
        });

        this.activeProcesses.set(serviceKey, child);

        if (child.stdout) {
          const rl = createInterface({ input: child.stdout });
          rl.on('line', (line) => {
            this.log(this.formatLog(def.name, def.color, line));
          });
        }

        if (child.stderr) {
          const rlErr = createInterface({ input: child.stderr });
          rlErr.on('line', (line) => {
            this.logError(this.formatLog(def.name, def.color, line));
          });
        }

        child.on('error', (err) => {
          if (this.completedServices.has(serviceKey)) return;
          this.completedServices.add(serviceKey);
          this.activeProcesses.delete(serviceKey);
          this.logError(
            this.formatLog(
              'supervisor',
              SUPERVISOR_COLOR,
              `Failed to spawn service "${def.name}": ${err.message}`,
            ),
          );
          this.handleChildFailure(serviceKey, 1);
        });

        child.on('exit', (code, signal) => {
          if (this.completedServices.has(serviceKey)) return;
          this.completedServices.add(serviceKey);
          this.activeProcesses.delete(serviceKey);
          if (!this.isShuttingDown) {
            const exitStatus = code !== null ? `code ${code}` : `signal ${signal}`;
            const log = code === 0 ? this.log : this.logError;
            log(
              this.formatLog(
                'supervisor',
                SUPERVISOR_COLOR,
                `Service "${def.name}" exited unexpectedly with ${exitStatus}. Terminating siblings...`,
              ),
            );
            this.handleChildFailure(serviceKey, code ?? 1);
          }
          this.checkAllExited();
        });
      } catch (err) {
        this.logError(
          this.formatLog(
            'supervisor',
            SUPERVISOR_COLOR,
            `Failed to start service "${def.name}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        this.handleChildFailure(serviceKey, 1);
        return;
      }
    }
  }

  private handleChildFailure(_service: ServiceKey, code: number): void {
    const failureCode = code === 0 ? 1 : code;
    if (this.exitCode === 0) {
      this.exitCode = failureCode;
    }
    this.stopAll();
  }

  public stopAll(signal = 'SIGTERM'): void {
    if (this.isShuttingDown && this.activeProcesses.size === 0) {
      return;
    }
    this.isShuttingDown = true;

    for (const child of this.activeProcesses.values()) {
      try {
        this.processTreeKillFn(child, signal);
      } catch {
        // Ignore if child already dead
      }
    }

    if (!this.shutdownTimer && this.activeProcesses.size > 0) {
      this.shutdownTimer = setTimeout(() => {
        for (const child of this.activeProcesses.values()) {
          try {
            this.processTreeKillFn(child, 'SIGKILL');
          } catch {
            // Ignore
          }
        }
        this.activeProcesses.clear();
        this.checkAllExited();
      }, this.gracefulTimeoutMs);
      if (this.shutdownTimer.unref) {
        this.shutdownTimer.unref();
      }
    }

    this.checkAllExited();
  }

  private checkAllExited(): void {
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

export function runMigration(rootDir: string, env: Record<string, string>): number {
  const result = spawnSync('node', ['scripts/prisma-guard.ts', 'migrate', 'deploy'], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
  });

  return result.status ?? 1;
}

function printUsage(): void {
  console.log(`FalseRoute Local-Development Supervisor

Usage:
  pnpm dev                         Start Web, API, and Worker concurrently
  pnpm dev:web                     Start only Web
  pnpm dev:api                     Start only API in watch mode
  pnpm dev:worker                  Start only Worker in watch mode
  pnpm dev:services                Start API and Worker concurrently
  pnpm dev:migrate                 Run guarded database migration
  pnpm dev:infra                   Start local PostgreSQL container
  pnpm dev:infra:down              Stop local PostgreSQL container

Options:
  --services=<list>                Comma-separated list of services (web,api,worker)
  --migrate                        Run guarded database migration using root .env
  --no-build                       Skip workspace dependency build step
  --env-file=<path>                Custom .env file path
  --help, -h                       Show this help message
`);
}

export async function main(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  let cliArgs: ParsedCliArgs;
  try {
    cliArgs = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[supervisor] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  const { env, hasEnvFile } = loadEnvironment({
    rootDir,
    envFile: cliArgs.envFile,
    processEnv: process.env,
  });

  if (cliArgs.migrate) {
    const validation = validateMigrationEnvironment(env, hasEnvFile);
    if (!validation.valid) {
      console.error('[supervisor] Migration environment validation failed:');
      for (const err of validation.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
    const exitCode = runMigration(rootDir, env);
    process.exit(exitCode);
  }

  const validation = validateServiceEnvironment(cliArgs.services, env, hasEnvFile);
  if (!validation.valid) {
    console.error('[supervisor] Environment validation failed:');
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const supervisor = new DevSupervisor({
    rootDir,
    services: cliArgs.services,
    env,
    skipBuild: cliArgs.skipBuild,
  });

  process.on('SIGINT', () => {
    console.log('\n[supervisor] Interrupted (SIGINT). Shutting down...');
    supervisor.stopAll('SIGINT');
  });

  process.on('SIGTERM', () => {
    console.log('\n[supervisor] Terminated (SIGTERM). Shutting down...');
    supervisor.stopAll('SIGTERM');
  });

  await supervisor.start();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[supervisor] Fatal error:', err);
    process.exit(1);
  });
}
