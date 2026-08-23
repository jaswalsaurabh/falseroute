import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

export const EmergencyReleaseRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    reason: z.string().min(1).max(500),
    confirmed: z.literal(true),
    requestedBy: z.string().min(1).max(128).optional(),
  })
  .strict();

export type EmergencyReleaseRequest = z.infer<typeof EmergencyReleaseRequestSchema>;

export const EmergencyReleaseResponseSchema = z
  .object({
    id: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(128),
    status: z.literal('RECORDED'),
    containmentMode: z.literal('SIMULATED'),
    releasedCount: z
      .object({
        falseRoutes: z.number().int().min(0),
        quarantines: z.number().int().min(0),
        decoys: z.number().int().min(0),
      })
      .strict(),
    requestedCount: z.number().int().min(0),
    verifiedCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    timestamp: IsoDateTimeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export type EmergencyReleaseResponse = z.infer<typeof EmergencyReleaseResponseSchema>;
