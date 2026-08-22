import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import {
  classifyProviderError,
  extractHttpStatus,
  sanitizeErrorMessage,
} from './error-classifier.js';

describe('error-classifier', () => {
  describe('extractHttpStatus', () => {
    it('extracts numeric status from error object fields', () => {
      expect(extractHttpStatus({ status: 429 })).toBe(429);
      expect(extractHttpStatus({ statusCode: 503 })).toBe(503);
      expect(extractHttpStatus({ response: { status: 401 } })).toBe(401);
    });

    it('extracts status code from error message regex', () => {
      expect(
        extractHttpStatus(new Error('API request failed with 500 Internal Server Error')),
      ).toBe(500);
      expect(extractHttpStatus(new Error('Quota exceeded [429 Too Many Requests]'))).toBe(429);
    });

    it('returns undefined when no status code is present', () => {
      expect(extractHttpStatus(new Error('Something unexpected happened'))).toBeUndefined();
      expect(extractHttpStatus(null)).toBeUndefined();
      expect(extractHttpStatus('non-object')).toBeUndefined();
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('redacts tokens, keys, passwords, and URLs', () => {
      const sensitive =
        'Failed connecting to https://api.example.com/v1 with key=dummy-secret-token and password: dummy-secret-password';
      const clean = sanitizeErrorMessage(sensitive);
      expect(clean).not.toContain('dummy-secret-token');
      expect(clean).not.toContain('dummy-secret-password');
      expect(clean).not.toContain('https://');
      expect(clean).toContain('[REDACTED]');
      expect(clean).toContain('[REDACTED_URL]');
    });

    it('redacts JSON quoted credential values and properties', () => {
      const jsonError = JSON.stringify({
        error: {
          message: 'Invalid credential provided',
          apiKey: 'dummy-not-a-real-api-key-12345',
          accessToken: 'dummy-not-a-real-access-token-67890',
          clientSecret: 'dummy-not-a-real-client-secret-abcde',
        },
      });
      const clean = sanitizeErrorMessage(jsonError);
      expect(clean).not.toContain('dummy-not-a-real-api-key-12345');
      expect(clean).not.toContain('dummy-not-a-real-access-token-67890');
      expect(clean).not.toContain('dummy-not-a-real-client-secret-abcde');
      expect(clean).toContain('[REDACTED]');
    });

    it('redacts Authorization Bearer headers', () => {
      const headerError =
        'Upstream returned 401 with Authorization: Bearer dummy-not-a-real-jwt-token-value';
      const clean = sanitizeErrorMessage(headerError);
      expect(clean).not.toContain('dummy-not-a-real-jwt-token-value');
      expect(clean).toContain('Authorization: [REDACTED]');
    });

    it('redacts credential-bearing URLs and query parameters', () => {
      const urlError =
        'Request failed: https://dummy-user:dummy-pass@api.example.com/models?apiKey=dummy-key-value';
      const clean = sanitizeErrorMessage(urlError);
      expect(clean).not.toContain('dummy-user');
      expect(clean).not.toContain('dummy-pass');
      expect(clean).not.toContain('dummy-key-value');
      expect(clean).toContain('[REDACTED_URL]');
    });

    it('normalizes multiline messages and truncates excessively long messages to 500 characters', () => {
      const multiline = `First line of error\n\tSecond line with key=dummy-key\r\nThird line: ${'A'.repeat(600)}`;
      const clean = sanitizeErrorMessage(multiline);
      expect(clean).not.toContain('\n');
      expect(clean).not.toContain('\r');
      expect(clean).not.toContain('\t');
      expect(clean).not.toContain('dummy-key');
      expect(clean.length).toBeLessThanOrEqual(500);
      expect(clean.endsWith('...')).toBe(true);
    });
  });

  describe('classifyProviderError', () => {
    it('ensures raw provider error messages never become sanitizedReason', () => {
      const rawSecret =
        'Internal stack trace leaking prompt="System prompt secret" and apiKey=dummy-key-val';
      const err = new Error(rawSecret);
      const classified = classifyProviderError(err);
      expect(classified.sanitizedReason).not.toContain(rawSecret);
      expect(classified.sanitizedReason).not.toContain('System prompt secret');
      expect(classified.sanitizedReason).not.toContain('dummy-key-val');
      expect(classified.sanitizedReason).toBe('Provider upstream failure');
    });

    it('classifies ZodError as SCHEMA_INVALID with allowlisted reason', () => {
      const TestSchema = z.object({ value: z.number() });
      try {
        TestSchema.parse({ value: 'not-a-number' });
      } catch (err) {
        const classified = classifyProviderError(err);
        expect(classified.kind).toBe('SCHEMA_INVALID');
        expect(classified.isRetriable).toBe(false);
        expect(classified.status).toBe('INVALID_OUTPUT');
        expect(classified.sanitizedReason).toBe('Provider output violated schema contract');
      }
    });

    it('classifies SyntaxError as SCHEMA_INVALID with allowlisted reason', () => {
      try {
        JSON.parse('invalid json {');
      } catch (err) {
        const classified = classifyProviderError(err);
        expect(classified.kind).toBe('SCHEMA_INVALID');
        expect(classified.isRetriable).toBe(false);
        expect(classified.status).toBe('INVALID_OUTPUT');
        expect(classified.sanitizedReason).toBe(
          'Provider returned non-JSON or invalid structured syntax',
        );
      }
    });

    it('classifies 429 rate limits as TRANSIENT with allowlisted reason', () => {
      const err = new Error(
        'Resource exhausted: 429 Too Many Requests with secret payload details',
      );
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.httpStatus).toBe(429);
      expect(classified.sanitizedReason).toBe('Provider rate limit or quota reached (HTTP 429)');
    });

    it('classifies 5xx server errors as TRANSIENT with allowlisted reason', () => {
      const err = Object.assign(
        new Error('Service Unavailable with internal DB connection string dummy://db'),
        { status: 503 },
      );
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.httpStatus).toBe(503);
      expect(classified.sanitizedReason).toBe('Transient upstream server error (HTTP 503)');
    });

    it('classifies network connection drops as TRANSIENT with allowlisted reason', () => {
      const err = Object.assign(
        new Error('read ECONNRESET on socket https://upstream.example.com'),
        { code: 'ECONNRESET' },
      );
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.sanitizedReason).toBe('Transient network failure');
    });

    it('classifies single request timeout as TRANSIENT with allowlisted reason', () => {
      const err = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'AbortError',
      });
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('TIMEOUT');
      expect(classified.sanitizedReason).toBe('Provider request timeout');
    });

    it('classifies complete operation deadline exceeded as TIMEOUT with allowlisted reason', () => {
      const err = new Error('Gemini complete operation deadline exceeded after 8000ms');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TIMEOUT');
      expect(classified.isRetriable).toBe(false);
      expect(classified.status).toBe('TIMEOUT');
      expect(classified.sanitizedReason).toBe('Operation deadline exceeded');
    });

    it('classifies cancelled request as CANCELLED with allowlisted reason', () => {
      const err = new Error('Caller cancelled request');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('CANCELLED');
      expect(classified.isRetriable).toBe(false);
      expect(classified.status).toBe('TIMEOUT');
      expect(classified.sanitizedReason).toBe('Provider request cancelled');
    });

    it('classifies 401 / 403 / 404 as AUTH_OR_CONFIG with allowlisted reason', () => {
      const err401 = Object.assign(new Error('API key not valid: dummy-key-12345'), {
        status: 401,
      });
      const classified401 = classifyProviderError(err401);
      expect(classified401.kind).toBe('AUTH_OR_CONFIG');
      expect(classified401.isRetriable).toBe(false);
      expect(classified401.status).toBe('UNAVAILABLE');
      expect(classified401.sanitizedReason).toBe(
        'Provider authentication or authorization failure (HTTP 401)',
      );

      const err404 = Object.assign(new Error('Model not found: models/dummy-model-v1'), {
        status: 404,
      });
      const classified404 = classifyProviderError(err404);
      expect(classified404.kind).toBe('AUTH_OR_CONFIG');
      expect(classified404.isRetriable).toBe(false);
      expect(classified404.sanitizedReason).toBe('Provider resource or model not found (HTTP 404)');
    });

    it('classifies 400 Bad Request as CLIENT_ERROR with allowlisted reason', () => {
      const err400 = Object.assign(new Error('Invalid argument provided in body: prompt details'), {
        status: 400,
      });
      const classified400 = classifyProviderError(err400);
      expect(classified400.kind).toBe('CLIENT_ERROR');
      expect(classified400.isRetriable).toBe(false);
      expect(classified400.status).toBe('INVALID_OUTPUT');
      expect(classified400.sanitizedReason).toBe(
        'Provider client error or invalid argument (HTTP 400)',
      );
    });

    it('classifies concurrency saturation as CONCURRENCY_SATURATED with allowlisted reason', () => {
      const err = new Error('Provider concurrency limit saturated (active: 2, max: 2)');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('CONCURRENCY_SATURATED');
      expect(classified.isRetriable).toBe(false);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.sanitizedReason).toBe('Provider capacity saturated');
    });

    it('prioritizes explicit numeric HTTP status codes over conflicting message heuristics', () => {
      // 401 with "service unavailable" -> 401 AUTH_OR_CONFIG wins
      const err401 = Object.assign(new Error('service unavailable at endpoint'), { status: 401 });
      const res401 = classifyProviderError(err401);
      expect(res401.kind).toBe('AUTH_OR_CONFIG');
      expect(res401.isRetriable).toBe(false);
      expect(res401.httpStatus).toBe(401);

      // 403 with "quota exceeded" -> 403 AUTH_OR_CONFIG wins
      const err403 = Object.assign(new Error('quota exceeded on project'), { status: 403 });
      const res403 = classifyProviderError(err403);
      expect(res403.kind).toBe('AUTH_OR_CONFIG');
      expect(res403.isRetriable).toBe(false);
      expect(res403.httpStatus).toBe(403);

      // 404 with "gateway timeout" -> 404 AUTH_OR_CONFIG wins
      const err404 = Object.assign(new Error('gateway timeout'), { status: 404 });
      const res404 = classifyProviderError(err404);
      expect(res404.kind).toBe('AUTH_OR_CONFIG');
      expect(res404.isRetriable).toBe(false);
      expect(res404.httpStatus).toBe(404);

      // 400 with "request timed out" -> 400 CLIENT_ERROR wins
      const err400 = Object.assign(new Error('request timed out'), { status: 400 });
      const res400 = classifyProviderError(err400);
      expect(res400.kind).toBe('CLIENT_ERROR');
      expect(res400.isRetriable).toBe(false);
      expect(res400.httpStatus).toBe(400);

      // 429 with "unauthenticated" -> 429 TRANSIENT wins
      const err429 = Object.assign(new Error('unauthenticated access attempt'), { status: 429 });
      const res429 = classifyProviderError(err429);
      expect(res429.kind).toBe('TRANSIENT');
      expect(res429.isRetriable).toBe(true);
      expect(res429.httpStatus).toBe(429);

      // 503 with "invalid argument" -> 503 TRANSIENT wins
      const err503 = Object.assign(new Error('invalid argument'), { status: 503 });
      const res503 = classifyProviderError(err503);
      expect(res503.kind).toBe('TRANSIENT');
      expect(res503.isRetriable).toBe(true);
      expect(res503.httpStatus).toBe(503);
    });

    it('bounds all allowlisted reason strings to 500 characters', () => {
      const errors = [
        new ZodError([]),
        new SyntaxError('bad json'),
        new Error('429 rate limit'),
        Object.assign(new Error('503 server error'), { status: 503 }),
        Object.assign(new Error('401 unauthenticated'), { status: 401 }),
        Object.assign(new Error('400 invalid argument'), { status: 400 }),
        new Error('operation deadline exceeded'),
        new Error('unknown random error'),
      ];

      for (const err of errors) {
        const classified = classifyProviderError(err);
        expect(classified.sanitizedReason.length).toBeLessThanOrEqual(500);
        expect(classified.sanitizedReason.length).toBeGreaterThan(0);
      }
    });
  });
});
