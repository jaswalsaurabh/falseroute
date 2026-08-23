import { z } from 'zod';
import { IpAddressSchema, IsoDateTimeSchema, UuidSchema } from './primitives.js';
import { LeaseStatusSchema } from './workflow.js';

export const DecoyTemplateIdSchema = z.enum(['mock-admin-decoy', 'mock-wordpress-decoy']);
export type DecoyTemplateId = z.infer<typeof DecoyTemplateIdSchema>;

export const DecoyDeploymentLeaseSchema = z
  .object({
    leaseId: UuidSchema,
    eventId: UuidSchema,
    templateName: DecoyTemplateIdSchema,
    imageDigest: z.string().min(1).max(128),
    desiredState: z.enum(['READY', 'DELETED']),
    observedState: z.enum(['PENDING', 'READY', 'FAILED', 'DELETED']),
    serviceUrl: z.string().max(256).optional(),
    healthStatus: z.enum(['HEALTHY', 'UNHEALTHY', 'UNKNOWN']),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    cleanedUpAt: IsoDateTimeSchema.optional(),
    leaseStatus: LeaseStatusSchema,
  })
  .strict();

export type DecoyDeploymentLease = z.infer<typeof DecoyDeploymentLeaseSchema>;

export const FalseRouteLeaseSchema = z
  .object({
    leaseId: UuidSchema,
    eventId: UuidSchema,
    sourceIp: IpAddressSchema,
    assignedRoute: z.string().min(1).max(128),
    desiredState: z.enum(['ACTIVE', 'REVOKED']),
    observedState: z.enum(['ACTIVE', 'REVOKED', 'FAILED']),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.optional(),
    leaseStatus: LeaseStatusSchema,
  })
  .strict();

export type FalseRouteLease = z.infer<typeof FalseRouteLeaseSchema>;

export const QuarantineLeaseSchema = z
  .object({
    leaseId: UuidSchema,
    eventId: UuidSchema,
    sourceCidr: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^(\d{1,3}\.){3}\d{1,3}\/32$|^[0-9a-fA-F:]+\/128$/,
        'Must be a strict /32 IPv4 or /128 IPv6 CIDR',
      ),
    policyName: z.literal('falseroute-quarantine-policy'),
    rulePriority: z.number().int().min(1000).max(1999),
    desiredState: z.enum(['ENFORCED', 'RELEASED']),
    observedState: z.enum(['ENFORCED', 'RELEASED', 'FAILED']),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    releasedAt: IsoDateTimeSchema.optional(),
    leaseStatus: LeaseStatusSchema,
  })
  .strict();

export type QuarantineLease = z.infer<typeof QuarantineLeaseSchema>;
