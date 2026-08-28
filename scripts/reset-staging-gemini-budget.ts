import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDatabaseClient } from '../packages/database/dist/client.js';

const TARGET_PROJECT = 'falseroute-staging-sj-20260822';
const TARGET_CATEGORY = 'DAILY_GEMINI_TOKENS' as const;
const CONFIRM_FLAG = '--confirm-staging-gemini-reset';
const EXECUTE_FLAG = '--execute';

export function currentUtcWindow(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function usage(): never {
  throw new Error(`Usage: node scripts/reset-staging-gemini-budget.ts [--execute ${CONFIRM_FLAG}]`);
}

export function assertTarget(
  args: readonly string[],
  databaseUrl: string | undefined,
  configuredProject = process.env['GCP_PROJECT_ID'],
): void {
  if (
    !databaseUrl ||
    (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://'))
  ) {
    throw new Error('DATABASE_URL must be an explicit PostgreSQL connection string.');
  }

  if (!args.includes(EXECUTE_FLAG) && args.includes(CONFIRM_FLAG)) {
    throw new Error(`The confirmation flag requires ${EXECUTE_FLAG}.`);
  }

  if (args.includes(EXECUTE_FLAG) && !args.includes(CONFIRM_FLAG)) {
    throw new Error(`Refusing to mutate the database without ${CONFIRM_FLAG}.`);
  }

  if (configuredProject !== TARGET_PROJECT) {
    throw new Error(
      `Refusing to run: GCP_PROJECT_ID must equal ${TARGET_PROJECT} for this staging-only utility.`,
    );
  }
}

interface BudgetRow {
  readonly status: string;
  readonly amountReserved: number | { toString(): string };
  readonly amountConsumed: number | { toString(): string } | null;
  readonly expiresAt: Date;
}

interface BudgetRecordClient {
  budgetReservationRecord: {
    findMany(args: unknown): Promise<readonly BudgetRow[]>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
  $transaction<T>(callback: (transaction: BudgetRecordClient) => Promise<T>): Promise<T>;
}

export interface ResetResult {
  readonly project: string;
  readonly category: typeof TARGET_CATEGORY;
  readonly windowKey: string;
  readonly matchingRows: number;
  readonly committedTokens: number;
  readonly deletedRows: number;
}

export async function resetCurrentGeminiBudget(
  prisma: BudgetRecordClient,
  options: { readonly execute: boolean; readonly windowKey?: string } = { execute: false },
): Promise<ResetResult> {
  const windowKey = options.windowKey ?? currentUtcWindow();
  const where = { category: TARGET_CATEGORY, windowKey };
  return prisma.$transaction(async (transaction) => {
    if (options.execute) {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${TARGET_CATEGORY} || ':' || ${windowKey}))
      `;
    }

    const rows = await transaction.budgetReservationRecord.findMany({
      where,
      select: {
        id: true,
        status: true,
        amountReserved: true,
        amountConsumed: true,
        geminiAttemptOutcome: true,
        expiresAt: true,
      },
    });

    if (
      options.execute &&
      rows.some((row) => row.status === 'RESERVED' && row.expiresAt > new Date())
    ) {
      throw new Error('Refusing to reset while an active Gemini reservation is still in flight.');
    }

    const committed = rows.reduce(
      (total, row) =>
        total +
        (row.status === 'CONSUMED' || row.status === 'RECONCILED'
          ? Number(row.amountConsumed ?? row.amountReserved)
          : row.status === 'RESERVED'
            ? Number(row.amountReserved)
            : 0),
      0,
    );

    const deletedRows = options.execute
      ? (await transaction.budgetReservationRecord.deleteMany({ where })).count
      : 0;

    return {
      project: TARGET_PROJECT,
      category: TARGET_CATEGORY,
      windowKey,
      matchingRows: rows.length,
      committedTokens: committed,
      deletedRows,
    };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => ![EXECUTE_FLAG, CONFIRM_FLAG].includes(arg))) {
    usage();
  }

  const databaseUrl = process.env['DATABASE_URL'];
  assertTarget(args, databaseUrl);
  const execute = args.includes(EXECUTE_FLAG);
  const prisma = createDatabaseClient({ connectionString: databaseUrl! });

  try {
    const result = await resetCurrentGeminiBudget(prisma, { execute });
    console.log(JSON.stringify({ ...result, mode: execute ? 'execute' : 'dry-run' }, null, 2));
    if (!execute) {
      console.log(`Dry run only. Add ${EXECUTE_FLAG} ${CONFIRM_FLAG} to reset these rows.`);
    } else {
      console.log(
        `Deleted ${result.deletedRows} current-window Gemini budget rows for staging only.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
