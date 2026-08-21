import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigurationError } from './index.js';

describe('Config — Environment Parsing & Validation', () => {
  it('parses valid environment with default values when empty', () => {
    const config = parseConfig({});
    expect(config).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses custom environment values accurately', () => {
    const env = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    };

    const config = parseConfig(env);
    expect(config).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    });
  });

  it('parses real ambient environment dictionary and strips extraneous system variables', () => {
    const realAmbientEnv = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      USER: 'operator',
      SHELL: '/bin/zsh',
      HOME: '/Users/operator',
      LANG: 'en_US.UTF-8',
    };

    const config = parseConfig(realAmbientEnv);
    expect(config).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
    });
    expect(Object.keys(config)).toEqual(['NODE_ENV', 'LOG_LEVEL']);
  });

  it('does not mutate the supplied environment object', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      PATH: '/bin',
    };
    const envCopy = { ...env };

    parseConfig(env);
    expect(env).toEqual(envCopy);
  });

  it('rejects invalid NODE_ENV with ConfigurationError', () => {
    expect(() => parseConfig({ NODE_ENV: 'staging' })).toThrow(ConfigurationError);

    try {
      parseConfig({ NODE_ENV: 'invalid_env' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const configErr = err as ConfigurationError;
      expect(configErr.issues.some((i) => i.variable === 'NODE_ENV')).toBe(true);
    }
  });

  it('rejects invalid LOG_LEVEL with ConfigurationError', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigurationError);

    try {
      parseConfig({ LOG_LEVEL: 'invalid_level' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const configErr = err as ConfigurationError;
      expect(configErr.issues.some((i) => i.variable === 'LOG_LEVEL')).toBe(true);
    }
  });

  it('does not expose secret values in error messages', () => {
    const sensitiveValue = 'super_secret_token_12345';
    const env = {
      NODE_ENV: sensitiveValue,
      LOG_LEVEL: sensitiveValue,
    };

    try {
      parseConfig(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const configErr = err as ConfigurationError;
      // Ensure the error message identifies the variable name without echoing the sensitive value
      expect(configErr.message).toContain('NODE_ENV');
      expect(configErr.message).toContain('LOG_LEVEL');
      expect(configErr.message).not.toContain(sensitiveValue);
      for (const issue of configErr.issues) {
        expect(issue.message).not.toContain(sensitiveValue);
      }
    }
  });
});
