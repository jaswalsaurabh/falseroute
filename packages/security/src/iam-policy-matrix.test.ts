import { describe, it, expect } from 'vitest';
import {
  evaluateRuntimeIamRole,
  evaluateRuntimeOperation,
  validateResourceAllowlist,
  ALLOWLISTED_REGION,
  DEDICATED_STAGING_PROJECT_ID,
} from './index.js';

describe('IAM Policy Matrix & Deny-Path Tests', () => {
  it('strictly forbids Owner and Editor roles to all runtime identities', () => {
    const identities = [
      'api-runtime',
      'worker-runtime',
      'decoy-runtime',
      'cleanup-runtime',
    ] as const;
    const forbiddenRoles = ['roles/owner', 'roles/editor'];

    for (const identity of identities) {
      for (const role of forbiddenRoles) {
        const decision = evaluateRuntimeIamRole(identity, role);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('Forbidden IAM role');
      }
    }
  });

  it('strictly forbids IAM and Resource Manager modification roles to all runtime identities', () => {
    const roles = [
      'roles/resourcemanager.organizationAdmin',
      'roles/resourcemanager.projectIamAdmin',
      'roles/iam.serviceAccountAdmin',
      'roles/iam.serviceAccountKeyAdmin',
      'roles/iam.securityAdmin',
    ];

    for (const role of roles) {
      const decision = evaluateRuntimeIamRole('worker-runtime', role);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Forbidden IAM role');
    }
  });

  it('enforces that decoy runtime identity has zero cloud permissions', () => {
    const testRoles = [
      'roles/viewer',
      'roles/run.viewer',
      'roles/storage.objectViewer',
      'roles/compute.networkViewer',
    ];

    for (const role of testRoles) {
      const decision = evaluateRuntimeIamRole('decoy-runtime', role);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('0 cloud permissions');
    }

    const opDecision = evaluateRuntimeOperation('decoy-runtime', 'any_operation');
    expect(opDecision.allowed).toBe(false);
  });

  it('forbids API runtime identity from Cloud Run or Cloud Armor mutation roles', () => {
    const runAdmin = evaluateRuntimeIamRole('api-runtime', 'roles/run.admin');
    expect(runAdmin.allowed).toBe(false);
    expect(runAdmin.reason).toContain('API runtime identity is forbidden');

    const armorAdmin = evaluateRuntimeIamRole('api-runtime', 'roles/compute.securityAdmin');
    expect(armorAdmin.allowed).toBe(false);

    const runMutationOp = evaluateRuntimeOperation('api-runtime', 'mutate_cloud_run');
    expect(runMutationOp.allowed).toBe(false);
  });

  it('forbids Worker runtime from modifying IAM policies', () => {
    const iamOp = evaluateRuntimeOperation('worker-runtime', 'modify_iam_policy');
    expect(iamOp.allowed).toBe(false);
  });

  it('forbids Cleanup runtime from modifying active non-expired leases', () => {
    const activeLeaseOp = evaluateRuntimeOperation('cleanup-runtime', 'modify_active_lease', {
      isLeaseExpired: false,
    });
    expect(activeLeaseOp.allowed).toBe(false);
    expect(activeLeaseOp.reason).toContain('forbidden from modifying active non-expired leases');

    const expiredLeaseOp = evaluateRuntimeOperation('cleanup-runtime', 'cleanup_expired_lease', {
      isLeaseExpired: true,
    });
    expect(expiredLeaseOp.allowed).toBe(true);
  });
});

describe('Resource Allowlist & Boundary Tests', () => {
  it('rejects an empty allowlist request', () => {
    const empty = validateResourceAllowlist({});
    expect(empty.allowed).toBe(false);
    expect(empty.violations.length).toBeGreaterThan(0);
  });

  it('accepts valid staging configuration within all allowlist boundaries', () => {
    const valid = validateResourceAllowlist({
      operation: 'deploy_decoy',
      projectId: DEDICATED_STAGING_PROJECT_ID,
      region: ALLOWLISTED_REGION,
      serviceName: 'falseroute-staging-decoy-admin-01',
      templateName: 'mock-admin-decoy',
      imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(valid.allowed).toBe(true);
    expect(valid.violations).toHaveLength(0);
  });

  it('rejects non-matching project IDs even with staging prefix', () => {
    const wrongStaging = validateResourceAllowlist({
      operation: 'deploy_decoy',
      projectId: 'falseroute-staging-other-project',
      region: ALLOWLISTED_REGION,
      serviceName: 'falseroute-staging-decoy-admin-01',
      templateName: 'mock-admin-decoy',
      imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(wrongStaging.allowed).toBe(false);
    expect(wrongStaging.violations[0]).toContain(
      `must exactly match configured dedicated project '${DEDICATED_STAGING_PROJECT_ID}'`,
    );
  });

  it('rejects caller attempts to override expectedProjectId for arbitrary projects', () => {
    const arbitraryOverride = validateResourceAllowlist({
      operation: 'deploy_decoy',
      projectId: 'some-other-project',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ expectedProjectId: 'some-other-project' } as any),
      region: ALLOWLISTED_REGION,
      serviceName: 'falseroute-staging-decoy-admin-01',
      templateName: 'mock-admin-decoy',
      imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(arbitraryOverride.allowed).toBe(false);
    expect(arbitraryOverride.violations[0]).toContain(
      `must exactly match configured dedicated project '${DEDICATED_STAGING_PROJECT_ID}'`,
    );
  });

  it('rejects non-allowlisted regions', () => {
    const wrongRegion = validateResourceAllowlist({ region: 'us-east1' });
    expect(wrongRegion.allowed).toBe(false);
    expect(wrongRegion.violations[0]).toContain("only 'us-central1' is allowlisted");
  });

  it('rejects unallowlisted decoy templates and digests not matching template allowlist', () => {
    const badTemplate = validateResourceAllowlist({
      templateName: 'unapproved-custom-decoy',
    });
    expect(badTemplate.allowed).toBe(false);
    expect(badTemplate.violations[0]).toContain(
      'must be one of [mock-admin-decoy, mock-wordpress-decoy]',
    );

    const mismatchedDigest = validateResourceAllowlist({
      templateName: 'mock-admin-decoy',
      imageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(mismatchedDigest.allowed).toBe(false);
    expect(mismatchedDigest.violations[0]).toContain(
      "is not allowlisted for template 'mock-admin-decoy'",
    );
  });

  it('strictly enforces Cloud Armor priority boundary (1000..1999)', () => {
    const tooLow = validateResourceAllowlist({ rulePriority: 999 });
    expect(tooLow.allowed).toBe(false);
    expect(tooLow.violations[0]).toContain('must be within range 1000..1999');

    const tooHigh = validateResourceAllowlist({ rulePriority: 2000 });
    expect(tooHigh.allowed).toBe(false);
    expect(tooHigh.violations[0]).toContain('must be within range 1000..1999');

    const validMin = validateResourceAllowlist({ rulePriority: 1000, ipCidr: '198.51.100.25/32' });
    expect(validMin.allowed).toBe(true);

    const validMax = validateResourceAllowlist({ rulePriority: 1999, ipCidr: '198.51.100.25/32' });
    expect(validMax.allowed).toBe(true);
  });

  it('rejects broad CIDR blocks (non-/32 IPv4 and non-/128 IPv6)', () => {
    const broadIpv4 = validateResourceAllowlist({ ipCidr: '198.51.100.0/24' });
    expect(broadIpv4.allowed).toBe(false);
    expect(broadIpv4.violations[0]).toContain('must be strict /32 single-host mask');

    const broadIpv6 = validateResourceAllowlist({ ipCidr: '2001:db8::/64' });
    expect(broadIpv6.allowed).toBe(false);
    expect(broadIpv6.violations[0]).toContain('must be strict /128 single-host mask');
  });

  it('unconditionally rejects private, loopback, link-local, multicast, ULA, unspecified, and IPv4-mapped IPv6 ranges', () => {
    const forbiddenIps = [
      '0.0.0.0/32', // IPv4 Unspecified
      '10.0.0.1/32', // RFC 1918 Private
      '172.16.5.10/32', // RFC 1918 Private
      '192.168.1.1/32', // RFC 1918 Private
      '127.0.0.1/32', // Loopback
      '169.254.169.254/32', // Link-local / GCP metadata
      '224.0.0.1/32', // Multicast
      '::/128', // IPv6 Unspecified
      '::1/128', // IPv6 Loopback
      'fc00::1/128', // IPv6 ULA
      'fd12:3456:789a::1/128', // IPv6 ULA
      'fe80::1/128', // IPv6 Link-local
      'ff02::1/128', // IPv6 Multicast
      '::ffff:10.0.0.1/128', // IPv4-mapped RFC1918 Private
      '::ffff:127.0.0.1/128', // IPv4-mapped Loopback
      '::ffff:169.254.169.254/128', // IPv4-mapped Metadata
    ];

    for (const ipCidr of forbiddenIps) {
      const decision = validateResourceAllowlist({ ipCidr });
      expect(decision.allowed).toBe(false);
      expect(decision.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects assign_route when projectId or region is omitted or invalid', () => {
    const missingProject = validateResourceAllowlist({
      operation: 'assign_route',
      region: ALLOWLISTED_REGION,
      ipCidr: '198.51.100.25/32',
    });
    expect(missingProject.allowed).toBe(false);
    expect(missingProject.violations).toContain('Missing required projectId for assign_route');

    const missingRegion = validateResourceAllowlist({
      operation: 'assign_route',
      projectId: DEDICATED_STAGING_PROJECT_ID,
      ipCidr: '198.51.100.25/32',
    });
    expect(missingRegion.allowed).toBe(false);
    expect(missingRegion.violations).toContain('Missing required region for assign_route');

    const valid = validateResourceAllowlist({
      operation: 'assign_route',
      projectId: DEDICATED_STAGING_PROJECT_ID,
      region: ALLOWLISTED_REGION,
      ipCidr: '198.51.100.25/32',
    });
    expect(valid.allowed).toBe(true);
  });

  it('rejects apply_quarantine when projectId or region is omitted or invalid', () => {
    const missingProject = validateResourceAllowlist({
      operation: 'apply_quarantine',
      region: ALLOWLISTED_REGION,
      ipCidr: '198.51.100.25/32',
      rulePriority: 1050,
    });
    expect(missingProject.allowed).toBe(false);
    expect(missingProject.violations).toContain('Missing required projectId for apply_quarantine');

    const missingRegion = validateResourceAllowlist({
      operation: 'apply_quarantine',
      projectId: DEDICATED_STAGING_PROJECT_ID,
      ipCidr: '198.51.100.25/32',
      rulePriority: 1050,
    });
    expect(missingRegion.allowed).toBe(false);
    expect(missingRegion.violations).toContain('Missing required region for apply_quarantine');

    const valid = validateResourceAllowlist({
      operation: 'apply_quarantine',
      projectId: DEDICATED_STAGING_PROJECT_ID,
      region: ALLOWLISTED_REGION,
      ipCidr: '198.51.100.25/32',
      rulePriority: 1050,
    });
    expect(valid.allowed).toBe(true);
  });
});
