import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalDevDatabaseUrl } from './dev-db-reset.ts';

test('validateLocalDevDatabaseUrl accepts valid local development database URLs', () => {
  const validUrl = 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public';
  const result = validateLocalDevDatabaseUrl(validUrl);

  assert.equal(result.valid, true);
  assert.equal(result.databaseName, 'falseroute_dev');
  assert.equal(result.maintenanceUrl, 'postgresql://falseroute:falseroute@127.0.0.1:5434/postgres');
});

test('validateLocalDevDatabaseUrl accepts localhost hostname', () => {
  const validUrl = 'postgresql://falseroute:falseroute@localhost:5434/falseroute_dev';
  const result = validateLocalDevDatabaseUrl(validUrl);

  assert.equal(result.valid, true);
  assert.equal(result.databaseName, 'falseroute_dev');
});

test('validateLocalDevDatabaseUrl rejects undefined and empty URLs', () => {
  const resUndefined = validateLocalDevDatabaseUrl(undefined);
  assert.equal(resUndefined.valid, false);
  assert.match(resUndefined.error ?? '', /Missing required environment variable/);

  const resEmpty = validateLocalDevDatabaseUrl('   ');
  assert.equal(resEmpty.valid, false);
  assert.match(resEmpty.error ?? '', /Missing required environment variable/);
});

test('validateLocalDevDatabaseUrl rejects remote database hosts', () => {
  const remoteUrl = 'postgresql://user:pass@db.production.example.com:5432/falseroute_dev';
  const result = validateLocalDevDatabaseUrl(remoteUrl);

  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /must target a local database host/);
});

test('validateLocalDevDatabaseUrl rejects non-dev databases to prevent accidental data loss', () => {
  const testUrl = 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_test?schema=public';
  const resTest = validateLocalDevDatabaseUrl(testUrl);
  assert.equal(resTest.valid, false);
  assert.match(resTest.error ?? '', /strictly restricted to approved development databases/);

  const prodUrl = 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_prod';
  const resProd = validateLocalDevDatabaseUrl(prodUrl);
  assert.equal(resProd.valid, false);
  assert.match(resProd.error ?? '', /strictly restricted to approved development databases/);

  const stagingUrl = 'postgresql://falseroute:falseroute@127.0.0.1:5434/staging_db';
  const resStaging = validateLocalDevDatabaseUrl(stagingUrl);
  assert.equal(resStaging.valid, false);
  assert.match(resStaging.error ?? '', /strictly restricted to approved development databases/);
});

test('validateLocalDevDatabaseUrl rejects malformed URLs', () => {
  const badUrl = 'not-a-url';
  const result = validateLocalDevDatabaseUrl(badUrl);

  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /must be a valid postgresql:\/\/ connection string/);
});
