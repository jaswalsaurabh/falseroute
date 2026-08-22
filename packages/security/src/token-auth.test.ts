import { describe, expect, it } from 'vitest';
import { verifyOperatorToken, extractBearerToken } from './token-auth.js';

describe('verifyOperatorToken', () => {
  const validSecret = 'falseroute-controlled-demo-secret-key-123';

  it('validates exact matching token', () => {
    expect(verifyOperatorToken(validSecret, validSecret)).toBe(true);
  });

  it('rejects incorrect token', () => {
    expect(verifyOperatorToken('wrong-secret-token', validSecret)).toBe(false);
  });

  it('rejects empty or missing candidate tokens safely', () => {
    expect(verifyOperatorToken('', validSecret)).toBe(false);
    expect(verifyOperatorToken(undefined, validSecret)).toBe(false);
    expect(verifyOperatorToken(null, validSecret)).toBe(false);
  });

  it('rejects candidate with different length', () => {
    expect(verifyOperatorToken('short', validSecret)).toBe(false);
    expect(verifyOperatorToken(`${validSecret}-longer`, validSecret)).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts token from standard Bearer header', () => {
    expect(extractBearerToken('Bearer my-secret-token')).toBe('my-secret-token');
    expect(extractBearerToken('bearer my-secret-token')).toBe('my-secret-token');
  });

  it('returns null for non-bearer or malformed headers', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('my-token-without-scheme')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
  });
});
