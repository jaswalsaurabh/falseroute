import net from 'node:net';

/**
 * Deterministic IAM Policy Matrix & Resource Allowlist Validator
 * Enforces least-privilege role separation and hard infrastructure boundaries for W0.
 *
 * NOTE: This is a local deterministic policy fixture used for pre-deployment invariant validation.
 * It is not claimed to represent live deployed Google Cloud IAM API enforcement.
 */

export type RuntimePrincipal =
  'api-runtime' | 'worker-runtime' | 'decoy-runtime' | 'cleanup-runtime';

export interface IamPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export type ResourceOperation = 'deploy_decoy' | 'assign_route' | 'apply_quarantine';

export interface ResourceAllowlistRequest {
  readonly operation?: ResourceOperation | undefined;
  readonly projectId?: string | undefined;
  readonly region?: string | undefined;
  readonly serviceName?: string | undefined;
  readonly templateName?: string | undefined;
  readonly imageDigest?: string | undefined;
  readonly rulePriority?: number | undefined;
  readonly ipCidr?: string | undefined;
}

export interface ResourceAllowlistDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly violations: readonly string[];
}

export const DEDICATED_STAGING_PROJECT_ID = 'falseroute-staging-sj-20260822';
export const ALLOWLISTED_REGION = 'us-central1';
export const CLOUD_ARMOR_PRIORITY_RANGE = Object.freeze({ min: 1000, max: 1999 });

export const ALLOWLISTED_TEMPLATES = Object.freeze(['mock-admin-decoy', 'mock-wordpress-decoy']);

export const ALLOWLISTED_TEMPLATE_DIGESTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'mock-admin-decoy': Object.freeze([
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ]),
    'mock-wordpress-decoy': Object.freeze([
      'sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    ]),
  });

const FORBIDDEN_GLOBAL_ROLES = Object.freeze([
  'roles/owner',
  'roles/editor',
  'roles/resourcemanager.organizationAdmin',
  'roles/resourcemanager.folderAdmin',
  'roles/resourcemanager.projectIamAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/iam.securityAdmin',
  'roles/iam.roleAdmin',
  'roles/iam.workloadIdentityUser',
]);

const ALLOWED_ROLE_MATRIX: Record<RuntimePrincipal, readonly string[]> = Object.freeze({
  'api-runtime': Object.freeze([
    'roles/pubsub.publisher',
    'roles/cloudsql.client',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
  ]),
  'worker-runtime': Object.freeze([
    'roles/pubsub.subscriber',
    'roles/cloudsql.client',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
    'roles/aiplatform.user',
  ]),
  'decoy-runtime': Object.freeze([]), // ZERO cloud permissions
  'cleanup-runtime': Object.freeze([
    'roles/cloudsql.client',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
  ]),
});

export function evaluateRuntimeIamRole(
  principal: RuntimePrincipal,
  role: string,
): IamPolicyDecision {
  // 1. Primitive Owner / Editor and IAM management roles are globally forbidden
  if (
    FORBIDDEN_GLOBAL_ROLES.includes(role) ||
    role.toLowerCase().includes('owner') ||
    role.toLowerCase().includes('editor') ||
    role.startsWith('roles/iam.') ||
    role.startsWith('roles/resourcemanager.')
  ) {
    return {
      allowed: false,
      reason: `Forbidden IAM role: '${role}' is an administrative or broad privilege role prohibited for runtime identities`,
    };
  }

  // 2. Decoy runtime identity must possess ZERO cloud permissions (containment boundary)
  if (principal === 'decoy-runtime') {
    return {
      allowed: false,
      reason: 'Decoy runtime identity must possess 0 cloud permissions (containment boundary)',
    };
  }

  // 3. API runtime cannot mutate Cloud Run or Cloud Armor
  if (principal === 'api-runtime') {
    if (
      role.includes('run.admin') ||
      role.includes('run.developer') ||
      role.includes('compute.securityAdmin') ||
      role.includes('compute.admin')
    ) {
      return {
        allowed: false,
        reason: 'API runtime identity is forbidden from Cloud Run or Cloud Armor mutation roles',
      };
    }
  }

  // 4. Worker runtime cannot modify IAM policies
  if (principal === 'worker-runtime') {
    if (role.includes('setIamPolicy') || role.includes('admin')) {
      return {
        allowed: false,
        reason: 'Worker runtime identity is forbidden from IAM mutation roles',
      };
    }
  }

  // 5. Default-deny check against explicit allowed role matrix
  const allowedRoles = ALLOWED_ROLE_MATRIX[principal];
  if (!allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `Role '${role}' is not on the explicit least-privilege allowlist for principal '${principal}'`,
    };
  }

  return {
    allowed: true,
    reason: `Role '${role}' is permitted for principal '${principal}' under least-privilege policy`,
  };
}

export function evaluateRuntimeOperation(
  principal: RuntimePrincipal,
  operation: string,
  context?: { isLeaseExpired?: boolean | undefined },
): IamPolicyDecision {
  if (principal === 'decoy-runtime') {
    return {
      allowed: false,
      reason: 'Decoy runtime identity has zero permissions and cannot execute cloud operations',
    };
  }

  if (principal === 'cleanup-runtime') {
    if (operation === 'modify_active_lease' && context?.isLeaseExpired === false) {
      return {
        allowed: false,
        reason: 'Cleanup runtime identity is forbidden from modifying active non-expired leases',
      };
    }
  }

  if (principal === 'api-runtime') {
    if (operation === 'mutate_cloud_run' || operation === 'mutate_cloud_armor') {
      return {
        allowed: false,
        reason:
          'API runtime identity cannot mutate Cloud Run or Cloud Armor infrastructure directly',
      };
    }
  }

  if (principal === 'worker-runtime') {
    if (operation === 'modify_iam_policy') {
      return {
        allowed: false,
        reason: 'Worker runtime identity cannot modify IAM policies',
      };
    }
  }

  return {
    allowed: true,
    reason: `Operation '${operation}' is authorized for principal '${principal}'`,
  };
}

export function validateResourceAllowlist(
  request: ResourceAllowlistRequest,
): ResourceAllowlistDecision {
  const violations: string[] = [];

  // Reject empty request if no parameters or operation provided
  if (Object.keys(request).length === 0) {
    return {
      allowed: false,
      reason: 'Empty resource allowlist request is rejected: operation and parameters are required',
      violations: ['Empty resource request'],
    };
  }

  // 1. Operation-specific mandatory field validation
  if (request.operation === 'deploy_decoy') {
    if (!request.projectId) violations.push('Missing required projectId for deploy_decoy');
    if (!request.region) violations.push('Missing required region for deploy_decoy');
    if (!request.templateName) violations.push('Missing required templateName for deploy_decoy');
    if (!request.imageDigest) violations.push('Missing required imageDigest for deploy_decoy');
    if (!request.serviceName) violations.push('Missing required serviceName for deploy_decoy');
  } else if (request.operation === 'assign_route') {
    if (!request.projectId) violations.push('Missing required projectId for assign_route');
    if (!request.region) violations.push('Missing required region for assign_route');
    if (!request.ipCidr) violations.push('Missing required ipCidr for assign_route');
  } else if (request.operation === 'apply_quarantine') {
    if (!request.projectId) violations.push('Missing required projectId for apply_quarantine');
    if (!request.region) violations.push('Missing required region for apply_quarantine');
    if (!request.ipCidr) violations.push('Missing required ipCidr for apply_quarantine');
    if (request.rulePriority === undefined)
      violations.push('Missing required rulePriority for apply_quarantine');
  }

  // 2. Target project constraint: must match exact dedicated project ID
  if (request.projectId !== undefined) {
    if (request.projectId !== DEDICATED_STAGING_PROJECT_ID) {
      violations.push(
        `Target project '${request.projectId}' is rejected: must exactly match configured dedicated project '${DEDICATED_STAGING_PROJECT_ID}'`,
      );
    }
  }

  // 3. Target region constraint: must be exact allowlisted region (us-central1)
  if (request.region !== undefined) {
    if (request.region !== ALLOWLISTED_REGION) {
      violations.push(
        `Target region '${request.region}' is rejected: only '${ALLOWLISTED_REGION}' is allowlisted`,
      );
    }
  }

  // 4. Target service naming constraint
  if (request.serviceName !== undefined) {
    if (!/^falseroute-staging-decoy-[a-z0-9-]+$/.test(request.serviceName)) {
      violations.push(
        `Service name '${request.serviceName}' is rejected: must match 'falseroute-staging-decoy-*'`,
      );
    }
  }

  // 5. Decoy template allowlist
  if (request.templateName !== undefined) {
    if (!ALLOWLISTED_TEMPLATES.includes(request.templateName)) {
      violations.push(
        `Decoy template '${request.templateName}' is rejected: must be one of [${ALLOWLISTED_TEMPLATES.join(', ')}]`,
      );
    }
  }

  // 6. Strict SHA-256 image digest validation & template mapping
  if (request.imageDigest !== undefined) {
    const isSha256 = /^sha256:[a-f0-9]{64}$/i.test(request.imageDigest);
    if (!isSha256) {
      violations.push(
        `Image digest '${request.imageDigest}' is rejected: must be an exact 64-hex SHA-256 digest`,
      );
    } else if (
      request.templateName !== undefined &&
      ALLOWLISTED_TEMPLATES.includes(request.templateName)
    ) {
      const allowedDigests = ALLOWLISTED_TEMPLATE_DIGESTS[request.templateName] ?? [];
      const normalizedDigest = request.imageDigest.toLowerCase();
      const matchesAllowlist = allowedDigests.some((d) => d.toLowerCase() === normalizedDigest);
      if (!matchesAllowlist) {
        violations.push(
          `Image digest '${request.imageDigest}' is not allowlisted for template '${request.templateName}'`,
        );
      }
    }
  }

  // 7. Cloud Armor priority range: 1000..1999
  if (request.rulePriority !== undefined) {
    if (
      request.rulePriority < CLOUD_ARMOR_PRIORITY_RANGE.min ||
      request.rulePriority > CLOUD_ARMOR_PRIORITY_RANGE.max
    ) {
      violations.push(
        `Cloud Armor priority ${request.rulePriority} is rejected: must be within range ${CLOUD_ARMOR_PRIORITY_RANGE.min}..${CLOUD_ARMOR_PRIORITY_RANGE.max}`,
      );
    }
  }

  // 8. Strict CIDR mask and IP range boundaries
  if (request.ipCidr !== undefined) {
    const cidrViolation = evaluateIpCidrAllowlist(request.ipCidr);
    if (cidrViolation) {
      violations.push(cidrViolation);
    }
  }

  const allowed = violations.length === 0;
  return {
    allowed,
    reason: allowed ? 'All resource parameters conform to allowlist policy' : violations.join('; '),
    violations,
  };
}

function evaluateIpCidrAllowlist(cidr: string): string | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) {
    return `Invalid CIDR format: '${cidr}'`;
  }

  const rawIp = parts[0]!.trim();
  const prefixStr = parts[1]!.trim();
  const prefix = Number.parseInt(prefixStr, 10);

  if (Number.isNaN(prefix) || !/^\d+$/.test(prefixStr)) {
    return `Invalid CIDR prefix: '${prefixStr}' in '${cidr}'`;
  }

  // Handle IPv4-mapped IPv6 representation (e.g. ::ffff:192.168.1.1 or ::ffff:10.0.0.1)
  const isMappedIpv4 =
    rawIp.toLowerCase().startsWith('::ffff:') && rawIp.includes('.') && net.isIPv6(rawIp);
  const ip = isMappedIpv4 ? rawIp.slice(7) : rawIp;
  const isIpv4 = net.isIPv4(ip);
  const isIpv6 = !isMappedIpv4 && net.isIPv6(ip);

  if (isIpv4) {
    if (prefix !== 32 && (!isMappedIpv4 || prefix !== 128)) {
      return `IPv4 CIDR prefix /${prefix} is rejected: must be strict /32 single-host mask`;
    }

    const octets = ip.split('.').map((o) => Number.parseInt(o, 10));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return `Invalid IPv4 address: '${rawIp}'`;
    }

    const [first, second, third, fourth] = octets as [number, number, number, number];

    // Unspecified: 0.0.0.0
    if (first === 0 && second === 0 && third === 0 && fourth === 0) {
      return `Unspecified IPv4 address '${rawIp}' is forbidden`;
    }

    // Loopback: 127.0.0.0/8
    if (first === 127) {
      return `Loopback address '${rawIp}' is forbidden`;
    }

    // Private RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    if (first === 10) return `Private RFC 1918 address '${rawIp}' is forbidden`;
    if (first === 172 && second >= 16 && second <= 31)
      return `Private RFC 1918 address '${rawIp}' is forbidden`;
    if (first === 192 && second === 168) return `Private RFC 1918 address '${rawIp}' is forbidden`;

    // Link-local & metadata: 169.254.0.0/16 (including 169.254.169.254)
    if (first === 169 && second === 254)
      return `Link-local/metadata address '${rawIp}' is forbidden`;

    // Multicast: 224.0.0.0/4 (224-239)
    if (first >= 224 && first <= 239) return `Multicast address '${rawIp}' is forbidden`;

    // Broadcast: 255.255.255.255 or 0.x.x.x
    if (first === 0 || first === 255) return `Special address '${rawIp}' is forbidden`;
  } else if (isIpv6) {
    if (prefix !== 128) {
      return `IPv6 CIDR prefix /${prefix} is rejected: must be strict /128 single-host mask`;
    }

    const lower = ip.toLowerCase();

    // Unspecified: :: or 0:0:0:0:0:0:0:0
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
      return `Unspecified IPv6 address '${rawIp}' is forbidden`;
    }

    // Loopback: ::1 or 0:0:0:0:0:0:0:1
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
      return `Loopback IPv6 '${rawIp}' is forbidden`;
    }

    // ULA (Unique Local Address): fc00::/7 (fc00... through fdff...)
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      return `Private ULA IPv6 '${rawIp}' is forbidden`;
    }

    // Link-local: fe80::/10 (fe80... through febf...)
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return `Link-local IPv6 '${rawIp}' is forbidden`;
    }

    // Multicast: ff00::/8
    if (lower.startsWith('ff')) {
      return `Multicast IPv6 '${rawIp}' is forbidden`;
    }
  } else {
    return `Unrecognized or invalid IP address format: '${rawIp}'`;
  }

  return null;
}
