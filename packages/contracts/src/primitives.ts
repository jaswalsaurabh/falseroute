import { z } from 'zod';

/**
 * Standard UUID schema.
 */
export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/**
 * ISO 8601 UTC datetime string schema.
 */
export const IsoDateTimeSchema = z.string().datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/**
 * Non-secret correlation identifier connecting events, model turns,
 * decisions, audit entries, logs, and traces.
 */
export const CorrelationIdSchema = z.string().min(1).max(64);
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

/**
 * Bounded IPv4 or IPv6 address schema.
 */
export const IpAddressSchema = z.union([z.string().ipv4(), z.string().ipv6()]);
export type IpAddress = z.infer<typeof IpAddressSchema>;

/**
 * Normalized confidence score strictly bounded between 0.0 and 1.0 inclusive.
 */
export const ConfidenceScoreSchema = z.number().min(0).max(1);
export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

/**
 * Application-defined allowlist of deception actions.
 * Model recommendations and deterministic decisions are strictly constrained to this set.
 */
export const DeceptionActionSchema = z.enum([
  'ASSIGN_FALSE_ROUTE',
  'ALLOW',
  'ALERT_OPERATOR',
  'OBSERVE',
]);
export type DeceptionAction = z.infer<typeof DeceptionActionSchema>;

/** Closed vocabulary for policy-owned response actions. */
export const ResponseActionSchema = z.enum([
  'RECOMMEND_PLAN',
  'DEPLOY_DECOY',
  'ASSIGN_FALSE_ROUTE',
  'QUARANTINE_SOURCE',
  'ALERT_OPERATOR',
  'REJECT_ACCESS',
  'NO_ACTION',
]);
export type ResponseAction = z.infer<typeof ResponseActionSchema>;

/**
 * Application-defined protected asset identifiers.
 * Phase 3A defines the fictional internal administrative portal.
 */
export const TargetAssetIdentifierSchema = z.enum(['mock-admin-portal']);
export type TargetAssetIdentifier = z.infer<typeof TargetAssetIdentifierSchema>;

/**
 * Application-defined decoy credential identifiers.
 * Phase 3A defines the fictional decoy credential for the administrative portal.
 */
export const DecoyIdentifierSchema = z.enum(['mock-admin-decoy-creds']);
export type DecoyIdentifier = z.infer<typeof DecoyIdentifierSchema>;

/**
 * Application-defined false route destinations.
 * In Phase 3A simulated mode, the only valid destination is mock-admin-decoy.
 */
export const FalseRouteIdentifierSchema = z.enum(['mock-admin-decoy']);
export type FalseRouteIdentifier = z.infer<typeof FalseRouteIdentifierSchema>;

/**
 * Application-defined deterministic deception policies.
 */
export const PolicyIdentifierSchema = z.enum([
  'DECOY_CREDENTIAL_TRIGGER',
  'HIGH_RISK_THRESHOLD',
  'DEFAULT_OBSERVATION',
]);
export type PolicyIdentifier = z.infer<typeof PolicyIdentifierSchema>;
