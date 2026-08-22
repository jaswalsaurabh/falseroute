import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
        'Failed connecting to https://api.google.com/v1 with key=AIzaSySecretToken and password: secret_password';
      const clean = sanitizeErrorMessage(sensitive);
      expect(clean).not.toContain('AIzaSySecretToken');
      expect(clean).not.toContain('secret_password');
      expect(clean).not.toContain('https://');
      expect(clean).toContain('[REDACTED]');
      expect(clean).toContain('[REDACTED_URL]');
    });

    it('truncates excessively long messages to 500 characters', () => {
      const longMessage = 'A'.repeat(800);
      const clean = sanitizeErrorMessage(longMessage);
      expect(clean.length).toBeLessThanOrEqual(500);
      expect(clean.endsWith('...')).toBe(true);
    });
  });

  describe('classifyProviderError', () => {
    it('classifies ZodError as SCHEMA_INVALID (non-retriable, INVALID_OUTPUT)', () => {
      const TestSchema = z.object({ value: z.number() });
      try {
        TestSchema.parse({ value: 'not-a-number' });
      } catch (err) {
        const classified = classifyProviderError(err);
        expect(classified.kind).toBe('SCHEMA_INVALID');
        expect(classified.isRetriable).toBe(false);
        expect(classified.status).toBe('INVALID_OUTPUT');
      }
    });

    it('classifies SyntaxError as SCHEMA_INVALID (non-retriable, INVALID_OUTPUT)', () => {
      try {
        JSON.parse('invalid json {');
      } catch (err) {
        const classified = classifyProviderError(err);
        expect(classified.kind).toBe('SCHEMA_INVALID');
        expect(classified.isRetriable).toBe(false);
        expect(classified.status).toBe('INVALID_OUTPUT');
      }
    });

    it('classifies 429 rate limits as TRANSIENT (retriable, UNAVAILABLE)', () => {
      const err = new Error('Resource exhausted: 429 Too Many Requests');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.httpStatus).toBe(429);
    });

    it('classifies 5xx server errors as TRANSIENT (retriable, UNAVAILABLE)', () => {
      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
      expect(classified.httpStatus).toBe(503);
    });

    it('classifies network connection drops as TRANSIENT (retriable, UNAVAILABLE)', () => {
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('UNAVAILABLE');
    });

    it('classifies single request timeout as TRANSIENT (retriable, TIMEOUT)', () => {
      const err = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'AbortError',
      });
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TRANSIENT');
      expect(classified.isRetriable).toBe(true);
      expect(classified.status).toBe('TIMEOUT');
    });

    it('classifies complete operation deadline exceeded as TIMEOUT (non-retriable, TIMEOUT)', () => {
      const err = new Error('Gemini complete operation deadline exceeded after 8000ms');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('TIMEOUT');
      expect(classified.isRetriable).toBe(false);
      expect(classified.status).toBe('TIMEOUT');
    });

    it('classifies 401 / 403 / 404 as AUTH_OR_CONFIG (non-retriable, UNAVAILABLE)', () => {
      const err401 = Object.assign(new Error('API key not valid'), { status: 401 });
      const classified401 = classifyProviderError(err401);
      expect(classified401.kind).toBe('AUTH_OR_CONFIG');
      expect(classified401.isRetriable).toBe(false);
      expect(classified401.status).toBe('UNAVAILABLE');

      const err404 = Object.assign(new Error('Model not found'), { status: 404 });
      const classified404 = classifyProviderError(err404);
      expect(classified404.kind).toBe('AUTH_OR_CONFIG');
      expect(classified404.isRetriable).toBe(false);
    });

    it('classifies 400 Bad Request as CLIENT_ERROR (non-retriable, INVALID_OUTPUT)', () => {
      const err400 = Object.assign(new Error('Invalid argument provided'), { status: 400 });
      const classified400 = classifyProviderError(err400);
      expect(classified400.kind).toBe('CLIENT_ERROR');
      expect(classified400.isRetriable).toBe(false);
      expect(classified400.status).toBe('INVALID_OUTPUT');
    });

    it('classifies concurrency saturation as CONCURRENCY_SATURATED (non-retriable, UNAVAILABLE)', () => {
      const err = new Error('Provider concurrency limit saturated (active: 2, max: 2)');
      const classified = classifyProviderError(err);
      expect(classified.kind).toBe('CONCURRENCY_SATURATED');
      expect(classified.isRetriable).toBe(false);
      expect(classified.status).toBe('UNAVAILABLE');
    });
  });
});
