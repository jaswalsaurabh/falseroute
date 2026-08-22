import { spawnSync } from 'node:child_process';
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

function main(): number {
  const prismaArgs = process.argv.slice(2);
  const validation = validatePrismaCommand(prismaArgs);

  if (!validation.allowed) {
    console.error(`Prisma command blocked: ${validation.reason}`);
    console.error(
      'Create migrations with: pnpm --filter @false-route/database migrate:dev -- --name <name>',
    );
    return 2;
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(
    'pnpm',
    ['--filter', '@false-route/database', 'exec', 'prisma', ...prismaArgs],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`Unable to run Prisma: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
