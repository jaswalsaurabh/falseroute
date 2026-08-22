import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface PrismaGuardResult {
  allowed: boolean;
  reason?: string;
}

const SAFE_SINGLE_COMMANDS = new Set(['format', 'generate', 'validate']);
const SAFE_MIGRATE_COMMANDS = new Set(['deploy', 'diff', 'status']);
const DESTRUCTIVE_FLAGS = ['--accept-data-loss', '--force-reset'] as const;

export function validatePrismaCommand(args: readonly string[]): PrismaGuardResult {
  if (args.length === 0) {
    return { allowed: false, reason: 'A Prisma command is required.' };
  }

  const [command, subcommand] = args;
  const destructiveFlag = args.find((argument) =>
    DESTRUCTIVE_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
  if (destructiveFlag) {
    return { allowed: false, reason: `${destructiveFlag} is prohibited.` };
  }

  if (command && SAFE_SINGLE_COMMANDS.has(command)) return { allowed: true };

  if (command === 'migrate') {
    if (subcommand === 'dev') {
      return args.includes('--create-only')
        ? { allowed: true }
        : { allowed: false, reason: 'migrate dev requires --create-only.' };
    }

    if (subcommand && SAFE_MIGRATE_COMMANDS.has(subcommand)) return { allowed: true };

    return {
      allowed: false,
      reason: `migrate ${subcommand ?? '[missing subcommand]'} is not an approved migration operation.`,
    };
  }

  if (command === 'db') {
    return {
      allowed: false,
      reason: 'Direct Prisma db commands are blocked; use reviewed migrations instead.',
    };
  }

  return { allowed: false, reason: `${command ?? '[unknown]'} is not an approved Prisma command.` };
}

export function resolvePnpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

export interface PrismaExecutionOptions {
  platform?: NodeJS.Platform | undefined;
  prismaArgs: readonly string[];
  repositoryRoot?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  spawnSyncFn?: SpawnSyncFn | undefined;
  logError?: ((message: string) => void) | undefined;
}

export function executePrismaCommand(options: PrismaExecutionOptions): number {
  const validation = validatePrismaCommand(options.prismaArgs);
  const logError = options.logError ?? ((msg: string) => console.error(msg));

  if (!validation.allowed) {
    logError(`Prisma command blocked: ${validation.reason}`);
    logError(
      'Create migrations with: pnpm --filter @false-route/database migrate:dev -- --name <name>',
    );
    return 2;
  }

  const platform = options.platform ?? process.platform;
  const executable = resolvePnpmExecutable(platform);
  const repositoryRoot =
    options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const spawnFn = (options.spawnSyncFn ?? spawnSync) as SpawnSyncFn;
  const env = options.env ?? process.env;

  const result = spawnFn(
    executable,
    ['--filter', '@false-route/database', 'exec', 'prisma', ...options.prismaArgs],
    {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      shell: false,
    },
  );

  if (result.error) {
    logError(`Unable to run Prisma: ${result.error.name ?? 'SpawnError'}`);
    return 1;
  }

  return result.status ?? 1;
}

function main(): number {
  const prismaArgs = process.argv.slice(2);
  return executePrismaCommand({ prismaArgs });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
