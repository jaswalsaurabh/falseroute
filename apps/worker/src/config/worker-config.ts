import { z } from 'zod';
import { BaseEnvironmentSchema, ConfigurationError } from '@false-route/config';

export const WorkerConfigSchema = BaseEnvironmentSchema.extend({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (val) => val.startsWith('postgresql://') || val.startsWith('postgres://'),
      'DATABASE_URL must be a valid PostgreSQL connection string',
    ),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),
  GEMINI_OPERATION_DEADLINE_MS: z.coerce.number().int().min(500).max(120000).default(8000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  GEMINI_MAX_QUEUE_SIZE: z.coerce.number().int().min(0).max(100).default(0),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(500),
  WORKER_CLAIM_LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  WORKER_MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
}).refine((config) => config.WORKER_CLAIM_LEASE_MS > config.GEMINI_OPERATION_DEADLINE_MS, {
  message: 'WORKER_CLAIM_LEASE_MS must be greater than GEMINI_OPERATION_DEADLINE_MS',
  path: ['WORKER_CLAIM_LEASE_MS'],
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function parseWorkerConfig(env: Record<string, string | undefined>): Readonly<WorkerConfig> {
  const result = WorkerConfigSchema.safeParse(env);
  if (!result.success) {
    throw ConfigurationError.fromZodError(result.error);
  }
  return Object.freeze({ ...result.data });
}
