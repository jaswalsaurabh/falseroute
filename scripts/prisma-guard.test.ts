import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePrismaCommand } from './prisma-guard.ts';

test('allows non-destructive Prisma commands', () => {
  assert.equal(validatePrismaCommand(['validate']).allowed, true);
  assert.equal(validatePrismaCommand(['generate']).allowed, true);
  assert.equal(validatePrismaCommand(['migrate', 'status']).allowed, true);
  assert.equal(validatePrismaCommand(['migrate', 'deploy']).allowed, true);
});

test('requires create-only when creating a development migration', () => {
  assert.deepEqual(validatePrismaCommand(['migrate', 'dev']), {
    allowed: false,
    reason: 'migrate dev requires --create-only.',
  });
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--name', 'add_event']).allowed,
    true,
  );
});

test('blocks reset, direct database commands, destructive flags, and unknown commands', () => {
  assert.equal(validatePrismaCommand(['migrate', 'reset']).allowed, false);
  assert.equal(validatePrismaCommand(['db', 'push']).allowed, false);
  assert.equal(validatePrismaCommand(['db', 'execute']).allowed, false);
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--force-reset']).allowed,
    false,
  );
  assert.equal(
    validatePrismaCommand(['migrate', 'dev', '--create-only', '--force-reset=true']).allowed,
    false,
  );
  assert.equal(validatePrismaCommand(['studio']).allowed, false);
});
