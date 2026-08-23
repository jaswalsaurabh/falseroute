import { z } from 'zod';
import { IsoDateTimeSchema, ConfidenceScoreSchema } from './primitives.js';

/**
 * Classification of data provenance across trust and evidence boundaries.
 * Distinguishes directly observed facts, model inferences, deterministic calculations,
 * unavailable data, and human operator actions.
 */
export const ProvenanceClassificationSchema = z.enum([
  'OBSERVED',
  'INFERRED',
  'DERIVED',
  'UNAVAILABLE',
  'OPERATOR',
]);

export type ProvenanceClassification = z.infer<typeof ProvenanceClassificationSchema>;

/**
 * Explicit evidence record preserving provenance, observation timestamp,
 * confidence boundary (0..1), and generating source identity.
 */
export const EvidenceRecordSchema = z
  .object({
    classification: ProvenanceClassificationSchema,
    source: z.string().min(1).max(128),
    observedAt: IsoDateTimeSchema,
    confidence: ConfidenceScoreSchema.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
