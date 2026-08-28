import { z } from 'zod';
import { BaseEnvironmentSchema, ConfigurationError } from '@false-route/config';
import { BUDGET_LIMITS } from '@false-route/contracts';

export const WorkerConfigSchema = BaseEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  WORKER_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (val) => val.startsWith('postgresql://') || val.startsWith('postgres://'),
      'DATABASE_URL must be a valid PostgreSQL connection string',
    ),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(30000),
  GEMINI_OPERATION_DEADLINE_MS: z.coerce.number().int().min(500).max(120000).default(60000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(1),
  GEMINI_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(1).max(10000).default(200),
  GEMINI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).max(60000).default(1000),
  GEMINI_RETRY_BACKOFF_MULTIPLIER: z.coerce.number().min(1).max(10).default(2),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  GEMINI_MAX_QUEUE_SIZE: z.coerce.number().int().min(0).max(100).default(0),
  GEMINI_DAILY_TOKEN_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(BUDGET_LIMITS.DAILY_GEMINI_TOKENS),
  PUBSUB_PROJECT_ID: z.string().min(6).optional(),
  PUBSUB_TOPIC_ID: z.string().min(3).default('falseroute-events'),
  AUTONOMOUS_PUSH_MODE: z
    .enum(['DISABLED', 'LOCAL_SHARED_SECRET', 'PUBSUB_EMULATOR', 'OIDC'])
    .default('DISABLED'),
  AUTONOMOUS_LOCAL_PUSH_TOKEN: z.string().min(16).optional(),
  PUBSUB_OIDC_AUDIENCE: z.string().url().optional(),
  PUBSUB_OIDC_SERVICE_ACCOUNT: z.string().email().optional(),
  CLEANUP_OIDC_SERVICE_ACCOUNT: z.string().email().optional(),
  OIDC_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(500),
  // Reserves time for deterministic policy evaluation and the fenced database transaction
  // after the complete Gemini operation deadline has elapsed.
  WORKER_CLAIM_PERSISTENCE_MARGIN_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  WORKER_CLAIM_LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(70000),
  WORKER_MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  WORKER_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  WORKER_DB_DISCONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(2000),
  WORKER_TELEMETRY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
})
  .superRefine((config, ctx) => {
    if (
      config.NODE_ENV === 'production' &&
      config.GEMINI_DAILY_TOKEN_LIMIT !== BUDGET_LIMITS.DAILY_GEMINI_TOKENS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GEMINI_DAILY_TOKEN_LIMIT'],
        message: 'Production must use the approved default Gemini daily token limit',
      });
    }
    if (config.AUTONOMOUS_PUSH_MODE === 'LOCAL_SHARED_SECRET') {
      if (config.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTONOMOUS_PUSH_MODE'],
          message: 'Local shared-secret push authentication is prohibited in production',
        });
      }
      if (!config.AUTONOMOUS_LOCAL_PUSH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTONOMOUS_LOCAL_PUSH_TOKEN'],
          message: 'AUTONOMOUS_LOCAL_PUSH_TOKEN is required for local push mode',
        });
      }
    }
    if (config.AUTONOMOUS_PUSH_MODE === 'PUBSUB_EMULATOR' && config.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTONOMOUS_PUSH_MODE'],
        message: 'Pub/Sub emulator push mode is prohibited in production',
      });
    }
    if (
      config.AUTONOMOUS_PUSH_MODE === 'OIDC' &&
      (!config.PUBSUB_OIDC_AUDIENCE || !config.PUBSUB_OIDC_SERVICE_ACCOUNT)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTONOMOUS_PUSH_MODE'],
        message: 'OIDC push mode requires expected audience and service-account identity',
      });
    }
    if (config.AUTONOMOUS_PUSH_MODE === 'OIDC' && !config.CLEANUP_OIDC_SERVICE_ACCOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLEANUP_OIDC_SERVICE_ACCOUNT'],
        message: 'OIDC push mode requires the cleanup service-account identity',
      });
    }
    if (config.AUTONOMOUS_PUSH_MODE === 'OIDC' && !config.PUBSUB_PROJECT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBSUB_PROJECT_ID'],
        message: 'OIDC push mode requires the Pub/Sub project ID for campaign continuation',
      });
    }
  })
  .refine(
    (config) => {
      return (
        config.WORKER_CLAIM_LEASE_MS >=
        config.GEMINI_OPERATION_DEADLINE_MS + config.WORKER_CLAIM_PERSISTENCE_MARGIN_MS
      );
    },
    {
      message:
        'WORKER_CLAIM_LEASE_MS must be at least GEMINI_OPERATION_DEADLINE_MS plus WORKER_CLAIM_PERSISTENCE_MARGIN_MS',
      path: ['WORKER_CLAIM_LEASE_MS'],
    },
  )
  .refine(
    (config) => {
      return (
        config.WORKER_DRAIN_TIMEOUT_MS +
          config.WORKER_DB_DISCONNECT_TIMEOUT_MS +
          config.WORKER_TELEMETRY_TIMEOUT_MS <=
        config.WORKER_SHUTDOWN_TIMEOUT_MS
      );
    },
    {
      message:
        'Sum of drain, database disconnect, and telemetry timeouts must not exceed total shutdown timeout',
      path: ['WORKER_SHUTDOWN_TIMEOUT_MS'],
    },
  );

type ParsedWorkerConfig = z.infer<typeof WorkerConfigSchema>;

export type WorkerConfig = Omit<
  ParsedWorkerConfig,
  | 'WORKER_SHUTDOWN_TIMEOUT_MS'
  | 'WORKER_DRAIN_TIMEOUT_MS'
  | 'WORKER_DB_DISCONNECT_TIMEOUT_MS'
  | 'WORKER_TELEMETRY_TIMEOUT_MS'
> & {
  WORKER_SHUTDOWN_TIMEOUT_MS?: number;
  WORKER_DRAIN_TIMEOUT_MS?: number;
  WORKER_DB_DISCONNECT_TIMEOUT_MS?: number;
  WORKER_TELEMETRY_TIMEOUT_MS?: number;
};

export function parseWorkerConfig(env: Record<string, string | undefined>): Readonly<WorkerConfig> {
  const result = WorkerConfigSchema.safeParse(env);
  if (!result.success) {
    throw ConfigurationError.fromZodError(result.error);
  }
  return Object.freeze({
    ...result.data,
    PORT: result.data.WORKER_PORT ?? result.data.PORT,
  });
}
