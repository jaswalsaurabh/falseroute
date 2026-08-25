import { describe, it, expect } from 'vitest';
import { createDatabaseClient, validateTestDatabaseUrl } from './client.js';

describe('Database client factory', () => {
  it('rejects missing or undefined configuration options', () => {
    // @ts-expect-error test invalid parameter
    expect(() => createDatabaseClient()).toThrow(
      'Database client requires an explicit options object with a connectionString property.',
    );
    // @ts-expect-error test invalid parameter
    expect(() => createDatabaseClient(null)).toThrow(
      'Database client requires an explicit options object with a connectionString property.',
    );
  });

  it('rejects empty or whitespace-only connection strings', () => {
    expect(() => createDatabaseClient({ connectionString: '' })).toThrow(
      'Database client connectionString cannot be empty.',
    );
    expect(() => createDatabaseClient({ connectionString: '   ' })).toThrow(
      'Database client connectionString cannot be empty.',
    );
  });

  it('rejects invalid URL protocols while redacting potential credentials', () => {
    expect(() =>
      createDatabaseClient({
        connectionString: 'http://dummy-user:dummy-password@localhost:5432/falseroute',
      }),
    ).toThrowError(/http:\/\/\*\*\*\*\*:\*\*\*\*\*@localhost:5432\/falseroute/);

    expect(() =>
      createDatabaseClient({
        connectionString: 'http://dummy-user:dummy-password@localhost:5432/falseroute',
      }),
    ).not.toThrowError(/dummy-password/);
  });

  it('instantiates the client without performing immediate network I/O', () => {
    // Standard mock PostgreSQL connection string with fictional local test credentials
    const fictionalUrl =
      'postgresql://not-a-real-user:not-a-real-password@127.0.0.1:54321/fictional_db';
    const client = createDatabaseClient({ connectionString: fictionalUrl });

    expect(client).toBeDefined();
    expect(typeof client.$connect).toBe('function');
    expect(typeof client.$disconnect).toBe('function');
    expect(typeof client.intrusionEvent).toBe('object');
    expect(typeof client.deceptionDecision).toBe('object');
    expect(typeof client.decisionAuditRecord).toBe('object');
  });
});

describe('validateTestDatabaseUrl', () => {
  it('rejects undefined, empty, or whitespace-only test database URLs', () => {
    expect(() => validateTestDatabaseUrl(undefined)).toThrowError(/explicit test database URL/);
    expect(() => validateTestDatabaseUrl('')).toThrowError(/explicit test database URL/);
    expect(() => validateTestDatabaseUrl('   ')).toThrowError(/explicit test database URL/);
  });

  it('rejects non-postgres protocols', () => {
    expect(() => validateTestDatabaseUrl('http://localhost:5432/falseroute_test')).toThrowError(
      /must begin with "postgresql:\/\/" or "postgres:\/\/"/,
    );
  });

  it('rejects development, staging, production, or non-test databases', () => {
    expect(() =>
      validateTestDatabaseUrl(
        'postgresql://not-a-real-user:not-a-real-password@localhost:5434/falseroute_dev?schema=public',
      ),
    ).toThrowError(/CRITICAL/);
    expect(() =>
      validateTestDatabaseUrl(
        'postgresql://not-a-real-user:not-a-real-password@localhost:5434/falseroute_prod?schema=public',
      ),
    ).toThrowError(/CRITICAL/);
    expect(() =>
      validateTestDatabaseUrl(
        'postgresql://not-a-real-user:not-a-real-password@localhost:5434/postgres?schema=public',
      ),
    ).toThrowError(/CRITICAL/);
    expect(() =>
      validateTestDatabaseUrl(
        'postgresql://not-a-real-user:not-a-real-password@localhost:5434/myapp?schema=public',
      ),
    ).toThrowError(/CRITICAL/);
  });

  it('accepts dedicated test database names ending with _test', () => {
    const validUrl =
      'postgresql://not-a-real-user:not-a-real-password@localhost:5434/falseroute_test?schema=public';
    expect(validateTestDatabaseUrl(validUrl)).toBe(validUrl);

    const isolatedSuiteUrl =
      'postgresql://not-a-real-user:not-a-real-password@localhost:5434/suite_integration_test';
    expect(validateTestDatabaseUrl(isolatedSuiteUrl)).toBe(isolatedSuiteUrl);
  });
});
