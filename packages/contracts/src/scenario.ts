import { z } from 'zod';
import { IpAddressSchema, ResponseActionSchema } from './primitives.js';

export const ScenarioKindSchema = z.enum([
  'ENV_FILE_PROBE',
  'WORDPRESS_CONFIG_PROBE',
  'SUSPICIOUS_IP_BURST',
  'SIP_INVITE_FLOOD',
  'TOKEN_TAMPER',
  'PATH_TRAVERSAL_PROBE',
  'DECOY_CREDENTIAL_USE',
  'SQL_INJECTION_PROBE',
  'CLOUD_METADATA_SSRF_PROBE',
  'CREDENTIAL_STUFFING_BURST',
]);

export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

function requireConsistentControlEvidence(
  evidence: { isPositiveMatch: boolean; isNegativeControl?: boolean | undefined },
  context: z.RefinementCtx,
): void {
  const isNegativeControl = evidence.isNegativeControl ?? false;
  if (evidence.isPositiveMatch === isNegativeControl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isNegativeControl'],
      message:
        'Control evidence is contradictory: positive matches must not be negative controls and negative matches must be marked as negative controls',
    });
  }
}

export interface PayloadBoundsOptions {
  readonly maxDepth?: number;
  readonly maxKeys?: number;
  readonly maxStringLength?: number;
  readonly maxTotalBytes?: number;
}

/**
 * Validates payload depth, key count, string length, and total byte size bounds.
 */
export function validatePayloadBounds(
  payload: unknown,
  options: PayloadBoundsOptions = {},
): { valid: true } | { valid: false; error: string } {
  const maxDepth = options.maxDepth ?? 5;
  const maxKeys = options.maxKeys ?? 50;
  const maxStringLength = options.maxStringLength ?? 500;
  const maxTotalBytes = options.maxTotalBytes ?? 16384; // 16 KB

  const jsonString = JSON.stringify(payload);
  if (jsonString && Buffer.byteLength(jsonString, 'utf8') > maxTotalBytes) {
    return {
      valid: false,
      error: `Payload exceeds maximum total size of ${maxTotalBytes} bytes`,
    };
  }

  let totalKeyCount = 0;

  function checkNode(
    node: unknown,
    currentDepth: number,
  ): { valid: true } | { valid: false; error: string } {
    if (currentDepth > maxDepth) {
      return { valid: false, error: `Payload exceeds maximum object nesting depth of ${maxDepth}` };
    }

    if (typeof node === 'string') {
      if (node.length > maxStringLength) {
        return {
          valid: false,
          error: `String field exceeds maximum length of ${maxStringLength} characters`,
        };
      }
      return { valid: true };
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const res = checkNode(item, currentDepth + 1);
        if (!res.valid) return res;
      }
      return { valid: true };
    }

    if (node !== null && typeof node === 'object') {
      const keys = Object.keys(node as Record<string, unknown>);
      totalKeyCount += keys.length;
      if (totalKeyCount > maxKeys) {
        return { valid: false, error: `Payload exceeds maximum total key count of ${maxKeys}` };
      }

      for (const key of keys) {
        if (key.length > maxStringLength) {
          return { valid: false, error: `Object key exceeds maximum length of ${maxStringLength}` };
        }
        const val = (node as Record<string, unknown>)[key];
        const res = checkNode(val, currentDepth + 1);
        if (!res.valid) return res;
      }
      return { valid: true };
    }

    return { valid: true };
  }

  return checkNode(payload, 1);
}

// Strict evidence schemas for each scenario
export const EnvFileProbeEvidenceSchema = z
  .object({
    scenarioKind: z.literal('ENV_FILE_PROBE').default('ENV_FILE_PROBE'),
    requestedPath: z
      .string()
      .min(1)
      .max(256)
      .regex(/\.env(\..+)?$/, 'Path must target a .env file'),
    httpMethod: z.enum(['GET', 'POST', 'HEAD']),
    userAgent: z.string().min(1).max(512),
    sourceIp: IpAddressSchema,
    matchedString: z.string().min(1).max(128),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type EnvFileProbeEvidence = z.infer<typeof EnvFileProbeEvidenceSchema>;

export const WordpressConfigProbeEvidenceSchema = z
  .object({
    scenarioKind: z.literal('WORDPRESS_CONFIG_PROBE').default('WORDPRESS_CONFIG_PROBE'),
    requestedPath: z
      .string()
      .min(1)
      .max(256)
      .regex(/wp-config(\.php)?(\.bak|\.old|\.txt)?$/i, 'Path must target wp-config'),
    httpMethod: z.enum(['GET', 'POST', 'HEAD']),
    userAgent: z.string().min(1).max(512),
    sourceIp: IpAddressSchema,
    matchedString: z.string().min(1).max(128),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type WordpressConfigProbeEvidence = z.infer<typeof WordpressConfigProbeEvidenceSchema>;

export const SuspiciousIpBurstEvidenceSchema = z
  .object({
    scenarioKind: z.literal('SUSPICIOUS_IP_BURST').default('SUSPICIOUS_IP_BURST'),
    sourceIp: IpAddressSchema,
    burstCount: z.number().int().min(1).max(10000),
    windowSeconds: z.number().int().min(1).max(3600),
    sampledEndpoints: z.array(z.string().min(1).max(256)).min(1).max(50),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type SuspiciousIpBurstEvidence = z.infer<typeof SuspiciousIpBurstEvidenceSchema>;

export const SipInviteFloodEvidenceSchema = z
  .object({
    scenarioKind: z.literal('SIP_INVITE_FLOOD').default('SIP_INVITE_FLOOD'),
    sourceIp: IpAddressSchema,
    sipCallId: z.string().min(1).max(128),
    inviteCount: z.number().int().min(1).max(50000),
    targetUri: z.string().min(1).max(256).regex(/^sip:/, 'Target URI must start with sip:'),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type SipInviteFloodEvidence = z.infer<typeof SipInviteFloodEvidenceSchema>;

export const TokenTamperEvidenceSchema = z
  .object({
    scenarioKind: z.literal('TOKEN_TAMPER').default('TOKEN_TAMPER'),
    sourceIp: IpAddressSchema,
    targetedEndpoint: z.string().min(1).max(256),
    tamperedClaims: z.array(z.string().min(1).max(64)).min(1).max(20),
    tokenPrefix: z.string().min(1).max(64),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type TokenTamperEvidence = z.infer<typeof TokenTamperEvidenceSchema>;

export const PathTraversalProbeEvidenceSchema = z
  .object({
    scenarioKind: z.literal('PATH_TRAVERSAL_PROBE').default('PATH_TRAVERSAL_PROBE'),
    requestedPath: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (p) =>
          p.includes('..') ||
          p.includes('/etc/passwd') ||
          p.includes('/etc/shadow') ||
          p.includes('win.ini'),
        'Path must contain traversal sequence or sensitive system target',
      ),
    httpMethod: z.enum(['GET', 'POST', 'HEAD']),
    userAgent: z.string().min(1).max(512),
    sourceIp: IpAddressSchema,
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);

export type PathTraversalProbeEvidence = z.infer<typeof PathTraversalProbeEvidenceSchema>;

export const SqlInjectionProbeEvidenceSchema = z
  .object({
    scenarioKind: z.literal('SQL_INJECTION_PROBE').default('SQL_INJECTION_PROBE'),
    sourceIp: IpAddressSchema,
    requestedPath: z.string().min(1).max(256),
    parameterName: z.string().min(1).max(64),
    detectionSignal: z.enum(['SQL_SYNTAX_MARKER', 'REPEATED_VARIATION', 'ERROR_PATTERN']),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);
export type SqlInjectionProbeEvidence = z.infer<typeof SqlInjectionProbeEvidenceSchema>;

export const CloudMetadataSsrfProbeEvidenceSchema = z
  .object({
    scenarioKind: z.literal('CLOUD_METADATA_SSRF_PROBE').default('CLOUD_METADATA_SSRF_PROBE'),
    sourceIp: IpAddressSchema,
    requestedPath: z.string().min(1).max(256),
    destinationClass: z.enum(['CLOUD_METADATA', 'LINK_LOCAL', 'PUBLIC']),
    httpMethod: z.enum(['GET', 'POST', 'HEAD']),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine(requireConsistentControlEvidence);
export type CloudMetadataSsrfProbeEvidence = z.infer<typeof CloudMetadataSsrfProbeEvidenceSchema>;

export const CredentialStuffingBurstEvidenceSchema = z
  .object({
    scenarioKind: z.literal('CREDENTIAL_STUFFING_BURST').default('CREDENTIAL_STUFFING_BURST'),
    sourceIp: IpAddressSchema,
    accountCount: z.number().int().min(1).max(1000),
    failureCount: z.number().int().min(1).max(50000),
    windowSeconds: z.number().int().min(1).max(3600),
    targetEndpoint: z.string().min(1).max(256),
    isPositiveMatch: z.boolean(),
    isNegativeControl: z.boolean().optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    requireConsistentControlEvidence(evidence, context);
    if (evidence.failureCount < evidence.accountCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCount'],
        message: 'failureCount must be at least accountCount',
      });
    }
  });
export type CredentialStuffingBurstEvidence = z.infer<typeof CredentialStuffingBurstEvidenceSchema>;

export const DecoyCredentialUseEvidenceSchema = z
  .object({
    scenarioKind: z.literal('DECOY_CREDENTIAL_USE').default('DECOY_CREDENTIAL_USE'),
    sourceIp: IpAddressSchema,
    usedDecoyCredential: z.literal(true),
    decoyIdentifier: z.literal('mock-admin-decoy'),
    targetAsset: z.string().min(1).max(64),
    failedLoginCount: z.number().int().min(0).max(1000),
    isPositiveMatch: z.literal(true),
    isNegativeControl: z.literal(false).optional(),
  })
  .strict();

export type DecoyCredentialUseEvidence = z.infer<typeof DecoyCredentialUseEvidenceSchema>;

export const ScenarioEvidenceSchema = z.union([
  EnvFileProbeEvidenceSchema,
  WordpressConfigProbeEvidenceSchema,
  SuspiciousIpBurstEvidenceSchema,
  SipInviteFloodEvidenceSchema,
  TokenTamperEvidenceSchema,
  PathTraversalProbeEvidenceSchema,
  DecoyCredentialUseEvidenceSchema,
  SqlInjectionProbeEvidenceSchema,
  CloudMetadataSsrfProbeEvidenceSchema,
  CredentialStuffingBurstEvidenceSchema,
]);

export type ScenarioEvidence = z.infer<typeof ScenarioEvidenceSchema>;

export const ScenarioActionOwnershipSchema = z
  .object({
    mandatoryActions: z.array(ResponseActionSchema).max(7),
    optionalActions: z.array(ResponseActionSchema).max(7),
    forbiddenActions: z.array(ResponseActionSchema).max(7),
    degradedFallbackActions: z.array(ResponseActionSchema).max(7),
  })
  .strict()
  .superRefine((ownership, context) => {
    const groups = [
      ['mandatoryActions', ownership.mandatoryActions],
      ['optionalActions', ownership.optionalActions],
      ['forbiddenActions', ownership.forbiddenActions],
      ['degradedFallbackActions', ownership.degradedFallbackActions],
    ] as const;
    const seen = new Map<string, string>();
    for (const [groupName, actions] of groups) {
      for (const action of actions) {
        const previousGroup = seen.get(action);
        if (previousGroup) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [groupName],
            message: `${action} cannot be in both ${previousGroup} and ${groupName}`,
          });
        } else {
          seen.set(action, groupName);
        }
      }
    }
  });
export type ScenarioActionOwnership = z.infer<typeof ScenarioActionOwnershipSchema>;

export interface ScenarioPreset {
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly description: string;
  readonly expectedPolicy: string;
  readonly allowedActions: readonly string[];
  readonly actionOwnership: ScenarioActionOwnership;
  readonly decoyTemplate?: string | undefined;
  readonly maxRiskScore: number;
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
  readonly negativeControl: {
    readonly isNegativeControl: boolean;
    readonly description: string;
  };
  readonly defaultEvidence: Record<string, unknown>;
}

export const SCENARIO_CATALOG: Record<ScenarioKind, ScenarioPreset> = {
  ENV_FILE_PROBE: {
    kind: 'ENV_FILE_PROBE',
    title: '.env Configuration Probe',
    description: 'Adversary probes web root for exposed environment variable files (.env)',
    expectedPolicy: 'POLICY_ENV_PROBE_CONTAINMENT',
    allowedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      forbiddenActions: ['QUARANTINE_SOURCE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    decoyTemplate: 'mock-admin-decoy',
    maxRiskScore: 85,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 1800,
    negativeControl: {
      isNegativeControl: false,
      description: 'Standard legitimate request to non-env asset returns 200 without false route',
    },
    defaultEvidence: {
      scenarioKind: 'ENV_FILE_PROBE',
      requestedPath: '/.env',
      httpMethod: 'GET',
      userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
      sourceIp: '198.51.100.25',
      matchedString: '.env',
      isPositiveMatch: true,
    },
  },
  WORDPRESS_CONFIG_PROBE: {
    kind: 'WORDPRESS_CONFIG_PROBE',
    title: 'WordPress Configuration Probe',
    description: 'Adversary scans for backup or exposed wp-config.php files',
    expectedPolicy: 'POLICY_WORDPRESS_PROBE_CONTAINMENT',
    allowedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      forbiddenActions: ['QUARANTINE_SOURCE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    decoyTemplate: 'mock-wordpress-decoy',
    maxRiskScore: 80,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 1800,
    negativeControl: {
      isNegativeControl: false,
      description: 'Legitimate request to WordPress index returns normal content',
    },
    defaultEvidence: {
      scenarioKind: 'WORDPRESS_CONFIG_PROBE',
      requestedPath: '/wp-config.php.bak',
      httpMethod: 'GET',
      userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
      sourceIp: '198.51.100.26',
      matchedString: 'wp-config.php.bak',
      isPositiveMatch: true,
    },
  },
  SUSPICIOUS_IP_BURST: {
    kind: 'SUSPICIOUS_IP_BURST',
    title: 'Suspicious IP Burst',
    description: 'Volumetric request spike across multiple endpoints from a single source IP',
    expectedPolicy: 'POLICY_IP_BURST_QUARANTINE',
    allowedActions: ['QUARANTINE_SOURCE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['QUARANTINE_SOURCE'],
      forbiddenActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    maxRiskScore: 90,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
    negativeControl: {
      isNegativeControl: false,
      description: 'Low-volume traffic below rate threshold remains unquarantined',
    },
    defaultEvidence: {
      scenarioKind: 'SUSPICIOUS_IP_BURST',
      sourceIp: '198.51.100.27',
      burstCount: 350,
      windowSeconds: 10,
      sampledEndpoints: ['/api/v1/login', '/api/v1/register', '/admin'],
      isPositiveMatch: true,
    },
  },
  SIP_INVITE_FLOOD: {
    kind: 'SIP_INVITE_FLOOD',
    title: 'SIP INVITE Flood Telemetry',
    description:
      'Volumetric SIP INVITE attack detected in ingress telemetry (autonomous quarantine response)',
    expectedPolicy: 'POLICY_SIP_FLOOD_QUARANTINE',
    allowedActions: ['QUARANTINE_SOURCE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['QUARANTINE_SOURCE'],
      forbiddenActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    maxRiskScore: 95,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
    negativeControl: {
      isNegativeControl: false,
      description: 'Legitimate SIP registration/invite does not trigger quarantine',
    },
    defaultEvidence: {
      scenarioKind: 'SIP_INVITE_FLOOD',
      sourceIp: '198.51.100.28',
      sipCallId: 'not-a-real-sip-call-12345@198.51.100.28',
      inviteCount: 1500,
      targetUri: 'sip:pbx.internal.dummy:5060',
      isPositiveMatch: true,
    },
  },
  TOKEN_TAMPER: {
    kind: 'TOKEN_TAMPER',
    title: 'Administrative Token Tamper',
    description: 'Bearer token signature manipulation or privilege escalation attempt detected',
    expectedPolicy: 'POLICY_TOKEN_TAMPER_REJECT_AND_ALERT',
    allowedActions: ['QUARANTINE_SOURCE', 'ALERT_OPERATOR', 'REJECT_ACCESS'],
    actionOwnership: {
      mandatoryActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
      optionalActions: ['QUARANTINE_SOURCE'],
      forbiddenActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      degradedFallbackActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
    },
    maxRiskScore: 95,
    defaultTtlSeconds: 900,
    maxTtlSeconds: 3600,
    negativeControl: {
      isNegativeControl: false,
      description: 'Validly signed operator bearer token is accepted normally',
    },
    defaultEvidence: {
      scenarioKind: 'TOKEN_TAMPER',
      sourceIp: '198.51.100.29',
      targetedEndpoint: '/api/v1/operator/actions',
      tamperedClaims: ['role:admin', 'iss:tampered-issuer'],
      tokenPrefix: 'dummy-tampered-token-prefix',
      isPositiveMatch: true,
    },
  },
  PATH_TRAVERSAL_PROBE: {
    kind: 'PATH_TRAVERSAL_PROBE',
    title: 'Path Traversal Probe',
    description: 'Dot-dot-slash or system file traversal probe in URL path parameter',
    expectedPolicy: 'POLICY_PATH_TRAVERSAL_CONTAINMENT',
    allowedActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      forbiddenActions: ['QUARANTINE_SOURCE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    decoyTemplate: 'mock-admin-decoy',
    maxRiskScore: 85,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 1800,
    negativeControl: {
      isNegativeControl: false,
      description: 'Normal path parameter without traversal sequence passes validation',
    },
    defaultEvidence: {
      scenarioKind: 'PATH_TRAVERSAL_PROBE',
      requestedPath: '/static/../../../../etc/passwd',
      httpMethod: 'GET',
      userAgent: 'Mozilla/5.0 (compatible; not-a-real-scanner/1.0)',
      sourceIp: '198.51.100.30',
      isPositiveMatch: true,
    },
  },
  DECOY_CREDENTIAL_USE: {
    kind: 'DECOY_CREDENTIAL_USE',
    title: 'Decoy Credential Use',
    description:
      'Use of known canary decoy credentials triggers deterministic false-route diversion',
    expectedPolicy: 'POLICY_DECOY_CREDENTIAL_DIVERSION',
    allowedActions: ['ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
    actionOwnership: {
      mandatoryActions: ['ASSIGN_FALSE_ROUTE', 'ALERT_OPERATOR'],
      optionalActions: [],
      forbiddenActions: ['DEPLOY_DECOY', 'QUARANTINE_SOURCE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    decoyTemplate: 'mock-admin-decoy',
    maxRiskScore: 100,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 1800,
    negativeControl: {
      isNegativeControl: false,
      description: 'Authentic user credentials authenticate without deception diversion',
    },
    defaultEvidence: {
      scenarioKind: 'DECOY_CREDENTIAL_USE',
      sourceIp: '198.51.100.31',
      usedDecoyCredential: true,
      decoyIdentifier: 'mock-admin-decoy',
      targetAsset: 'admin-portal',
      failedLoginCount: 1,
      isPositiveMatch: true,
    },
  },
  SQL_INJECTION_PROBE: {
    kind: 'SQL_INJECTION_PROBE',
    title: 'SQL Injection Probe',
    description: 'Synthetic input probe with bounded SQL detection evidence',
    expectedPolicy: 'POLICY_SQL_PROBE_ALERT',
    allowedActions: ['ALERT_OPERATOR', 'DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
    actionOwnership: {
      mandatoryActions: ['ALERT_OPERATOR'],
      optionalActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      forbiddenActions: ['QUARANTINE_SOURCE', 'REJECT_ACCESS'],
      degradedFallbackActions: ['ALERT_OPERATOR'],
    },
    decoyTemplate: 'mock-admin-decoy',
    maxRiskScore: 85,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 1800,
    negativeControl: {
      isNegativeControl: false,
      description: 'Ordinary parameter returns no SQL signal',
    },
    defaultEvidence: {
      scenarioKind: 'SQL_INJECTION_PROBE',
      sourceIp: '198.51.100.32',
      requestedPath: '/search',
      parameterName: 'query',
      detectionSignal: 'SQL_SYNTAX_MARKER',
      isPositiveMatch: true,
    },
  },
  CLOUD_METADATA_SSRF_PROBE: {
    kind: 'CLOUD_METADATA_SSRF_PROBE',
    title: 'Cloud Metadata SSRF Probe',
    description: 'Synthetic request targeting a prohibited cloud metadata destination class',
    expectedPolicy: 'POLICY_METADATA_SSRF_REJECT_AND_ALERT',
    allowedActions: ['REJECT_ACCESS', 'ALERT_OPERATOR', 'QUARANTINE_SOURCE'],
    actionOwnership: {
      mandatoryActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
      optionalActions: ['QUARANTINE_SOURCE'],
      forbiddenActions: ['DEPLOY_DECOY', 'ASSIGN_FALSE_ROUTE'],
      degradedFallbackActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
    },
    maxRiskScore: 95,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
    negativeControl: {
      isNegativeControl: false,
      description: 'Public documentation endpoint is not metadata',
    },
    defaultEvidence: {
      scenarioKind: 'CLOUD_METADATA_SSRF_PROBE',
      sourceIp: '198.51.100.33',
      requestedPath: '/fetch?url=http://metadata.google.internal',
      destinationClass: 'CLOUD_METADATA',
      httpMethod: 'GET',
      isPositiveMatch: true,
    },
  },
  CREDENTIAL_STUFFING_BURST: {
    kind: 'CREDENTIAL_STUFFING_BURST',
    title: 'Credential Stuffing Burst',
    description: 'Synthetic burst correlating accounts, failures, source, and time window',
    expectedPolicy: 'POLICY_CREDENTIAL_STUFFING_REJECT_AND_ALERT',
    allowedActions: ['REJECT_ACCESS', 'ALERT_OPERATOR', 'QUARANTINE_SOURCE'],
    actionOwnership: {
      mandatoryActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
      optionalActions: ['QUARANTINE_SOURCE'],
      forbiddenActions: [],
      degradedFallbackActions: ['REJECT_ACCESS', 'ALERT_OPERATOR'],
    },
    maxRiskScore: 95,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
    negativeControl: {
      isNegativeControl: false,
      description: 'One failed login does not indicate stuffing',
    },
    defaultEvidence: {
      scenarioKind: 'CREDENTIAL_STUFFING_BURST',
      sourceIp: '198.51.100.34',
      accountCount: 20,
      failureCount: 80,
      windowSeconds: 60,
      targetEndpoint: '/login',
      isPositiveMatch: true,
    },
  },
};

export function validateScenarioEvidence(
  kind: ScenarioKind,
  rawEvidence: unknown,
): { success: true; data: ScenarioEvidence } | { success: false; error: string } {
  // 1. First validate payload bounds
  const boundsCheck = validatePayloadBounds(rawEvidence);
  if (!boundsCheck.valid) {
    return { success: false, error: boundsCheck.error };
  }

  // 2. Validate per-kind schema
  try {
    const withKind =
      rawEvidence && typeof rawEvidence === 'object'
        ? { ...(rawEvidence as Record<string, unknown>), scenarioKind: kind }
        : rawEvidence;

    let parsed: ScenarioEvidence;
    switch (kind) {
      case 'ENV_FILE_PROBE':
        parsed = EnvFileProbeEvidenceSchema.parse(withKind);
        break;
      case 'WORDPRESS_CONFIG_PROBE':
        parsed = WordpressConfigProbeEvidenceSchema.parse(withKind);
        break;
      case 'SUSPICIOUS_IP_BURST':
        parsed = SuspiciousIpBurstEvidenceSchema.parse(withKind);
        break;
      case 'SIP_INVITE_FLOOD':
        parsed = SipInviteFloodEvidenceSchema.parse(withKind);
        break;
      case 'TOKEN_TAMPER':
        parsed = TokenTamperEvidenceSchema.parse(withKind);
        break;
      case 'PATH_TRAVERSAL_PROBE':
        parsed = PathTraversalProbeEvidenceSchema.parse(withKind);
        break;
      case 'DECOY_CREDENTIAL_USE':
        parsed = DecoyCredentialUseEvidenceSchema.parse(withKind);
        break;
      case 'SQL_INJECTION_PROBE':
        parsed = SqlInjectionProbeEvidenceSchema.parse(withKind);
        break;
      case 'CLOUD_METADATA_SSRF_PROBE':
        parsed = CloudMetadataSsrfProbeEvidenceSchema.parse(withKind);
        break;
      case 'CREDENTIAL_STUFFING_BURST':
        parsed = CredentialStuffingBurstEvidenceSchema.parse(withKind);
        break;
      default: {
        const exhaustiveCheck: never = kind;
        return { success: false, error: `Unknown scenario kind: ${exhaustiveCheck}` };
      }
    }

    return { success: true, data: parsed };
  } catch (err) {
    return {
      success: false,
      error: `Validation error for scenario ${kind}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
