import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTarget, resetCurrentGeminiBudget } from './reset-staging-gemini-budget.ts';

type MockClient = Parameters<typeof resetCurrentGeminiBudget>[0];

function makeClient() {
  const calls: { findMany?: unknown; deleteMany?: unknown } = {};
  const client: MockClient = {
    budgetReservationRecord: {
      async findMany(args: unknown) {
        calls.findMany = args;
        return [
          {
            status: 'CONSUMED',
            amountReserved: 8192,
            amountConsumed: 1200,
            expiresAt: new Date('2026-08-27T23:59:00Z'),
          },
          {
            status: 'RESERVED',
            amountReserved: 8192,
            amountConsumed: null,
            expiresAt: new Date('2026-08-27T23:59:00Z'),
          },
        ];
      },
      async deleteMany(args: unknown) {
        calls.deleteMany = args;
        return { count: 2 };
      },
    },
    async $executeRaw() {
      return 0;
    },
    async $transaction<T>(callback: (transaction: MockClient) => Promise<T>): Promise<T> {
      return callback(client);
    },
  };
  return { client, calls };
}

test('dry run reads only the current Gemini window and performs no delete', async () => {
  const { client, calls } = makeClient();
  const result = await resetCurrentGeminiBudget(client, {
    execute: false,
    windowKey: '2026-08-28',
  });

  assert.equal(result.deletedRows, 0);
  assert.equal(calls.deleteMany, undefined);
  assert.deepEqual(calls.findMany, {
    where: { category: 'DAILY_GEMINI_TOKENS', windowKey: '2026-08-28' },
    select: {
      id: true,
      status: true,
      amountReserved: true,
      amountConsumed: true,
      geminiAttemptOutcome: true,
      expiresAt: true,
    },
  });
});

test('execute deletes only the Gemini category in the selected UTC window', async () => {
  const { client, calls } = makeClient();
  const result = await resetCurrentGeminiBudget(client, {
    execute: true,
    windowKey: '2026-08-28',
  });

  assert.equal(result.deletedRows, 2);
  assert.deepEqual(calls.deleteMany, {
    where: { category: 'DAILY_GEMINI_TOKENS', windowKey: '2026-08-28' },
  });
  assert.equal(JSON.stringify(calls.deleteMany).includes('DAILY_USD'), false);
  assert.equal(JSON.stringify(calls.deleteMany).includes('HOURLY_TOOL_OPERATIONS'), false);
});

test('execute refuses to delete an active in-flight Gemini reservation', async () => {
  const { client } = makeClient();
  client.budgetReservationRecord.findMany = async () => [
    {
      status: 'RESERVED',
      amountReserved: 8192,
      amountConsumed: null,
      expiresAt: new Date(Date.now() + 60_000),
    },
  ];

  await assert.rejects(
    resetCurrentGeminiBudget(client, { execute: true, windowKey: '2026-08-28' }),
    /active Gemini reservation is still in flight/,
  );
});

test('staging guard rejects execution without both explicit flags', () => {
  const databaseUrl = 'postgresql://dummy-user:dummy-pass@staging.example.invalid:5432/example';

  assert.throws(
    () => assertTarget(['--execute'], databaseUrl, 'falseroute-staging-sj-20260822'),
    /without --confirm-staging-gemini-reset/,
  );
  assert.throws(
    () =>
      assertTarget(
        ['--confirm-staging-gemini-reset'],
        databaseUrl,
        'falseroute-staging-sj-20260822',
      ),
    /requires --execute/,
  );
});

test('staging guard rejects a different project before database access', () => {
  assert.throws(
    () =>
      assertTarget(
        ['--execute', '--confirm-staging-gemini-reset'],
        'postgresql://dummy-user:dummy-pass@staging.example.invalid:5432/example',
        'another-project',
      ),
    /must equal falseroute-staging-sj-20260822/,
  );
});
