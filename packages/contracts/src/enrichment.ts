import { z } from 'zod';
import {
  CorrelationIdSchema,
  ConfidenceScoreSchema,
  IsoDateTimeSchema,
  FalseRouteIdentifierSchema,
} from './primitives.js';

/**
 * Base shared fields for a model enrichment and recommendation result.
 */
const BaseModelEnrichmentSchema = z.object({
  correlationId: CorrelationIdSchema,
  confidence: ConfidenceScoreSchema,
  summary: z.string().min(1).max(500),
  explanation: z.string().min(1).max(2000),
  provenance: z.literal('INFERRED'),
  modelIdentifier: z.string().min(1).max(100),
  evaluatedAt: IsoDateTimeSchema,
});

/**
 * Model recommendation to assign a false route.
 * Requires an application-allowlisted false route destination.
 */
export const AssignFalseRouteRecommendationSchema = BaseModelEnrichmentSchema.extend({
  recommendedAction: z.literal('ASSIGN_FALSE_ROUTE'),
  suggestedFalseRoute: FalseRouteIdentifierSchema,
}).strict();

export type AssignFalseRouteRecommendation = z.infer<typeof AssignFalseRouteRecommendationSchema>;

/**
 * Model recommendation to allow the session without a false route.
 * Prohibits suggestedFalseRoute to prevent contradictory recommendations.
 */
export const AllowRecommendationSchema = BaseModelEnrichmentSchema.extend({
  recommendedAction: z.literal('ALLOW'),
  suggestedFalseRoute: z.undefined().optional(),
}).strict();

export type AllowRecommendation = z.infer<typeof AllowRecommendationSchema>;

/**
 * Model recommendation to alert the operator without a false route.
 * Prohibits suggestedFalseRoute to prevent contradictory recommendations.
 */
export const AlertOperatorRecommendationSchema = BaseModelEnrichmentSchema.extend({
  recommendedAction: z.literal('ALERT_OPERATOR'),
  suggestedFalseRoute: z.undefined().optional(),
}).strict();

export type AlertOperatorRecommendation = z.infer<typeof AlertOperatorRecommendationSchema>;

/**
 * Model recommendation to observe the session without a false route.
 * Prohibits suggestedFalseRoute to prevent contradictory recommendations.
 */
export const ObserveRecommendationSchema = BaseModelEnrichmentSchema.extend({
  recommendedAction: z.literal('OBSERVE'),
  suggestedFalseRoute: z.undefined().optional(),
}).strict();

export type ObserveRecommendation = z.infer<typeof ObserveRecommendationSchema>;

/**
 * Bounded model enrichment and recommendation schema.
 * Discriminated union on `recommendedAction` ensuring route and non-route recommendations
 * cannot contain contradictory false-route properties.
 */
export const ModelEnrichmentResultSchema = z.discriminatedUnion('recommendedAction', [
  AssignFalseRouteRecommendationSchema,
  AllowRecommendationSchema,
  AlertOperatorRecommendationSchema,
  ObserveRecommendationSchema,
]);

export type ModelEnrichmentResult = z.infer<typeof ModelEnrichmentResultSchema>;

/**
 * Degraded model result recorded when Gemini times out, is unavailable,
 * or returns unparseable/unsafe structured output.
 * Carries UNAVAILABLE provenance to ensure uncertainty is not masked.
 */
export const DegradedModelResultSchema = z
  .object({
    correlationId: CorrelationIdSchema,
    status: z.enum(['DEGRADED', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_OUTPUT']),
    reason: z.string().min(1).max(500),
    provenance: z.literal('UNAVAILABLE'),
    evaluatedAt: IsoDateTimeSchema,
  })
  .strict();

export type DegradedModelResult = z.infer<typeof DegradedModelResultSchema>;
