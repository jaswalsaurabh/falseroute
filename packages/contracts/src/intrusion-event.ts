import { z } from 'zod';
import {
  UuidSchema,
  IsoDateTimeSchema,
  CorrelationIdSchema,
  IpAddressSchema,
  TargetAssetIdentifierSchema,
  DecoyIdentifierSchema,
} from './primitives.js';
import { ScenarioKindSchema } from './scenario.js';

/**
 * Processing lifecycle status for an intrusion event.
 */
export const ProcessingStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'ENRICHED',
  'DECIDED',
  'FAILED',
]);

export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;

/**
 * Containment execution mode.
 * Phase 3A operates strictly under SIMULATED containment.
 */
export const ContainmentModeSchema = z.enum(['SIMULATED']);

export type ContainmentMode = z.infer<typeof ContainmentModeSchema>;

/**
 * Validated types of intrusion activity.
 */
export const EventTypeSchema = z.enum([
  'UNAUTHORIZED_ACCESS_ATTEMPT',
  'CREDENTIAL_STUFFING',
  'SUSPICIOUS_LOGIN',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Base shared fields for simulated intrusion event input.
 */
const BaseSimulatedEventInputSchema = z.object({
  id: UuidSchema,
  occurredAt: IsoDateTimeSchema,
  correlationId: CorrelationIdSchema,
  sourceIp: IpAddressSchema,
  targetAsset: TargetAssetIdentifierSchema,
  eventType: EventTypeSchema,
  scenarioKind: ScenarioKindSchema.optional(),
  failedLoginCount: z.number().int().min(0).max(1000),
  riskIndicators: z.array(z.string().min(1).max(100)).max(20),
  containmentMode: ContainmentModeSchema,
});

/**
 * Event input where a decoy credential was used.
 * Requires an explicit application-defined decoy identifier.
 */
export const DecoyTriggeredEventInputSchema = BaseSimulatedEventInputSchema.extend({
  usedDecoyCredential: z.literal(true),
  decoyIdentifier: DecoyIdentifierSchema,
}).strict();

export type DecoyTriggeredEventInput = z.infer<typeof DecoyTriggeredEventInputSchema>;

/**
 * Standard event input where no decoy credential was used.
 * Prohibits decoy credential identifiers to prevent contradictory evidence states.
 */
export const StandardEventInputSchema = BaseSimulatedEventInputSchema.extend({
  usedDecoyCredential: z.literal(false),
  decoyIdentifier: z.undefined().optional(),
}).strict();

export type StandardEventInput = z.infer<typeof StandardEventInputSchema>;

/**
 * Untrusted input schema submitted by the event simulator.
 * Discriminated union on `usedDecoyCredential` preventing invalid/contradictory evidence states.
 */
export const SimulatedIntrusionEventInputSchema = z.discriminatedUnion('usedDecoyCredential', [
  DecoyTriggeredEventInputSchema,
  StandardEventInputSchema,
]);

export type SimulatedIntrusionEventInput = z.infer<typeof SimulatedIntrusionEventInputSchema>;

/**
 * Internal decoy-triggered event schema with ingestion metadata and OBSERVED provenance.
 */
export const DecoyTriggeredIntrusionEventSchema = DecoyTriggeredEventInputSchema.extend({
  receivedAt: IsoDateTimeSchema,
  status: ProcessingStatusSchema,
  provenance: z.literal('OBSERVED'),
}).strict();

export type DecoyTriggeredIntrusionEvent = z.infer<typeof DecoyTriggeredIntrusionEventSchema>;

/**
 * Internal standard event schema with ingestion metadata and OBSERVED provenance.
 */
export const StandardIntrusionEventSchema = StandardEventInputSchema.extend({
  receivedAt: IsoDateTimeSchema,
  status: ProcessingStatusSchema,
  provenance: z.literal('OBSERVED'),
}).strict();

export type StandardIntrusionEvent = z.infer<typeof StandardIntrusionEventSchema>;

/**
 * Validated canonical representation of an intrusion event across internal boundaries.
 */
export const IntrusionEventSchema = z.discriminatedUnion('usedDecoyCredential', [
  DecoyTriggeredIntrusionEventSchema,
  StandardIntrusionEventSchema,
]);

export type IntrusionEvent = z.infer<typeof IntrusionEventSchema>;
