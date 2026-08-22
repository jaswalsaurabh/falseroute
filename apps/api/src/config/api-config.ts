import { z } from 'zod';
import { BaseEnvironmentSchema, ConfigurationError } from '@false-route/config';

export const ApiConfigSchema = BaseEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (val) => val.startsWith('postgresql://') || val.startsWith('postgres://'),
      'DATABASE_URL must be a valid PostgreSQL connection string',
    ),
  OPERATOR_ACCESS_TOKEN: z
    .string()
    .min(8, 'OPERATOR_ACCESS_TOKEN must be at least 8 characters long'),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000',
    ),
  ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
  /**
   * Number of trusted reverse-proxy hops for source-IP resolution. Defaults to
   * 0 (fail closed): client-supplied forwarding headers are ignored unless the
   * deployment explicitly declares trusted proxy hops.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

type ParsedApiConfig = z.infer<typeof ApiConfigSchema>;

/**
 * ApiConfig consumers outside the app may construct config objects without the
 * optional deployment-only keys; the schema still defaults them at parse time.
 */
export type ApiConfig = Omit<ParsedApiConfig, 'TRUST_PROXY_HOPS'> & {
  TRUST_PROXY_HOPS?: number;
};

export function parseApiConfig(env: Record<string, string | undefined>): Readonly<ApiConfig> {
  const result = ApiConfigSchema.safeParse(env);
  if (!result.success) {
    throw ConfigurationError.fromZodError(result.error);
  }
  return Object.freeze({ ...result.data });
}
