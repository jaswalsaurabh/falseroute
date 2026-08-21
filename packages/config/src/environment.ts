import { z } from 'zod';
import { ConfigurationError } from './errors.js';

export const NodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof NodeEnvSchema>;

export const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Schema for genuinely shared core environment variables justified in Phase 3A.
 * Standard object stripping is used so real process.env dictionaries can be passed
 * without failing on ambient system variables (PATH, USER, etc.).
 */
export const BaseEnvironmentSchema = z.object({
  NODE_ENV: NodeEnvSchema.default('development'),
  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type AppConfig = z.infer<typeof BaseEnvironmentSchema>;

/**
 * Parses and validates untrusted environment input into an immutable typed configuration.
 * Requires an explicit environment dictionary to guarantee determinism and testability
 * without implicit ambient global state reading.
 */
export function parseConfig(env: Record<string, string | undefined>): Readonly<AppConfig> {
  const result = BaseEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw ConfigurationError.fromZodError(result.error);
  }
  return Object.freeze({ ...result.data });
}
