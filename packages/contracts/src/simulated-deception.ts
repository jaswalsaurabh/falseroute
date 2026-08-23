import { z } from 'zod';
import {
  UuidSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  FalseRouteIdentifierSchema,
} from './primitives.js';

/**
 * Constrained command dispatched to the simulated deception agent.
 * Contains only bounded, non-secret parameters required for simulated route recording.
 * Explicitly excludes raw model output, prompts, credentials, arbitrary URLs, and host parameters.
 */
export const SimulatedDeceptionCommandSchema = z
  .object({
    decisionId: UuidSchema,
    correlationId: CorrelationIdSchema,
    action: z.literal('ASSIGN_FALSE_ROUTE'),
    containmentMode: z.literal('SIMULATED'),
    assignedFalseRoute: FalseRouteIdentifierSchema,
    commandProvenance: z.literal('DERIVED'),
  })
  .strict();

export type SimulatedDeceptionCommand = z.infer<typeof SimulatedDeceptionCommandSchema>;

/**
 * Bounded result returned by the in-process simulated deception adapter.
 * Proves the simulation was recorded without executing any real external effect.
 */
export const SimulatedDeceptionResultSchema = z
  .object({
    status: z.literal('RECORDED'),
    recordedAt: IsoDateTimeSchema,
    adapterVersion: z.string().min(1).max(32),
    provenance: z.literal('DERIVED'),
  })
  .strict();

export type SimulatedDeceptionResult = z.infer<typeof SimulatedDeceptionResultSchema>;

/**
 * Persisted evidence of a recorded simulated deception assignment.
 * Maintains an atomic 1:1 durable proof with the corresponding deception decision.
 */
export const SimulatedDeceptionEffectSchema = z
  .object({
    id: UuidSchema,
    decisionId: UuidSchema,
    correlationId: CorrelationIdSchema,
    effectKind: z.literal('ASSIGN_FALSE_ROUTE'),
    status: z.literal('RECORDED'),
    containmentMode: z.literal('SIMULATED'),
    assignedFalseRoute: FalseRouteIdentifierSchema,
    provenance: z.literal('DERIVED'),
    recordedAt: IsoDateTimeSchema,
    adapterVersion: z.string().min(1).max(32),
    createdAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export type SimulatedDeceptionEffect = z.infer<typeof SimulatedDeceptionEffectSchema>;
