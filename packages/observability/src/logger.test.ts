import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, withCorrelationContext } from './logger.js';
import { REDACTED_PLACEHOLDER } from './redaction.js';

describe('createLogger', () => {
  it('creates a logger with base service attributes and ISO timestamp', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({
      serviceName: 'test-service',
      environment: 'test',
      destination: stream,
    });

    logger.info('Test log message');

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.msg).toBe('Test log message');
    expect(parsed.service).toBe('test-service');
    expect(parsed.env).toBe('test');
    expect(parsed.level).toBe('info');
    expect(parsed.time).toBeDefined();
  });

  it('redacts sensitive fields in log payloads', () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({
      serviceName: 'test-service',
      destination: stream,
    });

    logger.info({
      token: 'dummy-secret-token-value',
      authorization: 'Bearer dummy-sensitive-token',
      operatorToken: 'dummy-operator-key',
      password: 'password123',
      normalField: 'visible-data',
    });

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.token).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.authorization).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.operatorToken).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.password).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.normalField).toBe('visible-data');
  });

  it('attaches correlation and event context via child logger', () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const rootLogger = createLogger({
      serviceName: 'test-service',
      destination: stream,
    });

    const childLogger = withCorrelationContext(rootLogger, {
      correlationId: 'corr-xyz-123',
      eventId: 'evt-uuid-456',
    });

    childLogger.info('Event processing step');

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.correlationId).toBe('corr-xyz-123');
    expect(parsed.eventId).toBe('evt-uuid-456');
    expect(parsed.msg).toBe('Event processing step');
  });

  it('redacts deeply nested unrecognized properties containing secrets', () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({
      serviceName: 'test-service',
      destination: stream,
    });

    logger.info({
      nested: {
        deeply: {
          operatorToken: 'dummy-nested-secret-value-123',
          unrecognizedSecretKey: 'dummy-should-be-redacted',
          apiKey: 'dummy-nested-api-key',
        },
      },
    });

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      nested: { deeply: { operatorToken: string; apiKey: string } };
    };
    expect(parsed.nested.deeply.operatorToken).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.nested.deeply.apiKey).toBe(REDACTED_PLACEHOLDER);
  });

  it('sanitizes embedded credentials inside database URLs in log messages and error objects', () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({
      serviceName: 'test-service',
      destination: stream,
    });

    const sensitiveDbUrl =
      'postgresql://dummy-user:dummy-database-password@10.0.0.1:5432/falseroute_test?schema=public';

    logger.error(
      {
        error: new Error(`Connection to ${sensitiveDbUrl} failed`),
        rawDbUrl: sensitiveDbUrl,
      },
      `Failed to connect to ${sensitiveDbUrl}`,
    );

    expect(logs.length).toBe(1);
    const rawLog = logs[0] ?? '';
    expect(rawLog).not.toContain('dummy-database-password');
    expect(rawLog).toContain('postgresql://dummy-user:[REDACTED]@10.0.0.1:5432');
  });
});
