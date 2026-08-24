import { z } from 'zod';
import { BaseEnvironmentSchema, ConfigurationError } from '@false-route/config';
import { SystemModeSchema } from '@false-route/contracts';

export const ApiConfigSchema = BaseEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
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
  OPERATOR_REPLAY_TOKEN: z.string().min(16).optional(),
  EVENT_PUBLISHER_MODE: z
    .enum(['MEMORY', 'LOCAL_HTTP', 'PUBSUB_EMULATOR', 'LIVE_PUBSUB'])
    .default('MEMORY'),
  PUBSUB_PROJECT_ID: z.string().min(6).optional(),
  PUBSUB_TOPIC_ID: z.string().min(3).default('falseroute-events'),
  PUBSUB_EMULATOR_HOST: z.string().min(1).optional(),
  LOCAL_WORKER_PUSH_URL: z.string().url().default('http://127.0.0.1:8088/pubsub/push'),
  LOCAL_WORKER_PUSH_TOKEN: z.string().min(16).optional(),
  EVENT_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000',
    ),
  ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(2000),
  SHUTDOWN_TELEMETRY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  /**
   * Number of trusted reverse-proxy hops for source-IP resolution. Defaults to
   * 0 (fail closed): client-supplied forwarding headers are ignored unless the
   * deployment explicitly declares trusted proxy hops.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  SYSTEM_MODE: SystemModeSchema.default('LOCAL_FAKE'),
})
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.EVENT_PUBLISHER_MODE === 'MEMORY') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENT_PUBLISHER_MODE'],
        message: 'Production must use an explicitly configured durable event publisher',
      });
    }
    if (config.EVENT_PUBLISHER_MODE === 'LOCAL_HTTP') {
      if (config.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EVENT_PUBLISHER_MODE'],
          message: 'LOCAL_HTTP event publishing is prohibited in production',
        });
      }
      if (!config.LOCAL_WORKER_PUSH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOCAL_WORKER_PUSH_TOKEN'],
          message: 'LOCAL_WORKER_PUSH_TOKEN is required for LOCAL_HTTP event publishing',
        });
      }
    }
    if (
      (config.EVENT_PUBLISHER_MODE === 'LIVE_PUBSUB' ||
        config.EVENT_PUBLISHER_MODE === 'PUBSUB_EMULATOR') &&
      !config.PUBSUB_PROJECT_ID
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBSUB_PROJECT_ID'],
        message: 'PUBSUB_PROJECT_ID is required for live Pub/Sub publishing',
      });
    }
    if (config.EVENT_PUBLISHER_MODE === 'PUBSUB_EMULATOR' && !config.PUBSUB_EMULATOR_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBSUB_EMULATOR_HOST'],
        message: 'PUBSUB_EMULATOR_HOST is required for Pub/Sub emulator publishing',
      });
    }
    if (config.NODE_ENV === 'production' && config.EVENT_PUBLISHER_MODE === 'PUBSUB_EMULATOR') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENT_PUBLISHER_MODE'],
        message: 'Pub/Sub emulator publishing is prohibited in production',
      });
    }
    if (
      config.OPERATOR_REPLAY_TOKEN !== undefined &&
      config.OPERATOR_REPLAY_TOKEN === config.OPERATOR_ACCESS_TOKEN
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPERATOR_REPLAY_TOKEN'],
        message: 'OPERATOR_REPLAY_TOKEN must be distinct from OPERATOR_ACCESS_TOKEN',
      });
    }
  })
  .refine(
    (config) => {
      return (
        config.SHUTDOWN_DRAIN_TIMEOUT_MS +
          config.SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS +
          config.SHUTDOWN_TELEMETRY_TIMEOUT_MS <=
        config.SHUTDOWN_TIMEOUT_MS
      );
    },
    {
      message:
        'Sum of drain, database disconnect, and telemetry timeouts must not exceed total shutdown timeout',
      path: ['SHUTDOWN_TIMEOUT_MS'],
    },
  );

type ParsedApiConfig = z.infer<typeof ApiConfigSchema>;

/**
 * ApiConfig consumers outside the app may construct config objects without the
 * optional deployment-only keys; the schema still defaults them at parse time.
 */
export type ApiConfig = Omit<
  ParsedApiConfig,
  | 'TRUST_PROXY_HOPS'
  | 'SHUTDOWN_TIMEOUT_MS'
  | 'SHUTDOWN_DRAIN_TIMEOUT_MS'
  | 'SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS'
  | 'SHUTDOWN_TELEMETRY_TIMEOUT_MS'
  | 'OPERATOR_REPLAY_TOKEN'
  | 'EVENT_PUBLISHER_MODE'
  | 'PUBSUB_PROJECT_ID'
  | 'PUBSUB_TOPIC_ID'
  | 'PUBSUB_EMULATOR_HOST'
  | 'SYSTEM_MODE'
  | 'LOCAL_WORKER_PUSH_URL'
  | 'LOCAL_WORKER_PUSH_TOKEN'
  | 'EVENT_PUBLISH_TIMEOUT_MS'
> & {
  TRUST_PROXY_HOPS?: number;
  SHUTDOWN_TIMEOUT_MS?: number;
  SHUTDOWN_DRAIN_TIMEOUT_MS?: number;
  SHUTDOWN_DB_DISCONNECT_TIMEOUT_MS?: number;
  SHUTDOWN_TELEMETRY_TIMEOUT_MS?: number;
  OPERATOR_REPLAY_TOKEN?: string | undefined;
  EVENT_PUBLISHER_MODE?: 'MEMORY' | 'LOCAL_HTTP' | 'PUBSUB_EMULATOR' | 'LIVE_PUBSUB';
  PUBSUB_PROJECT_ID?: string | undefined;
  PUBSUB_TOPIC_ID?: string;
  PUBSUB_EMULATOR_HOST?: string | undefined;
  SYSTEM_MODE?: z.infer<typeof SystemModeSchema>;
  LOCAL_WORKER_PUSH_URL?: string;
  LOCAL_WORKER_PUSH_TOKEN?: string | undefined;
  EVENT_PUBLISH_TIMEOUT_MS?: number;
};

export function parseApiConfig(env: Record<string, string | undefined>): Readonly<ApiConfig> {
  const result = ApiConfigSchema.safeParse(env);
  if (!result.success) {
    throw ConfigurationError.fromZodError(result.error);
  }
  return Object.freeze({ ...result.data });
}
