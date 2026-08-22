import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTION_PATHS,
  REDACTED_PLACEHOLDER,
  sanitizeLogData,
  sanitizeUrlCredentials,
} from './redaction.js';

describe('redaction utilities', () => {
  it('defines comprehensive redaction paths for secrets and tokens', () => {
    expect(DEFAULT_REDACTION_PATHS).toContain('authorization');
    expect(DEFAULT_REDACTION_PATHS).toContain('token');
    expect(DEFAULT_REDACTION_PATHS).toContain('password');
    expect(DEFAULT_REDACTION_PATHS).toContain('apiKey');
    expect(DEFAULT_REDACTION_PATHS).toContain('operatorToken');
    expect(DEFAULT_REDACTION_PATHS).toContain('prompt');
    expect(DEFAULT_REDACTION_PATHS).toContain('modelResponse');
  });

  it('redacts credentials from connection string URLs', () => {
    const rawUrl = 'postgresql://dummy-user:dummy-password@127.0.0.1:5432/falseroute_dev';
    const sanitized = sanitizeUrlCredentials(rawUrl);
    expect(sanitized).toBe('postgresql://dummy-user:[REDACTED]@127.0.0.1:5432/falseroute_dev');
    expect(sanitized).not.toContain('dummy-password');
  });

  it('sanitizes sensitive keys in nested plain objects', () => {
    const raw = {
      correlationId: 'corr-123',
      operatorToken: 'dummy-secret-token',
      nested: {
        apiKey: 'dummy-gemini-key-999',
        normalField: 'visible-value',
        password: 'dummy-admin-password',
      },
    };

    const sanitized = sanitizeLogData(raw);

    expect(sanitized.correlationId).toBe('corr-123');
    expect(sanitized.operatorToken).toBe(REDACTED_PLACEHOLDER);
    expect(sanitized.nested.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(sanitized.nested.password).toBe(REDACTED_PLACEHOLDER);
    expect(sanitized.nested.normalField).toBe('visible-value');
  });
});
