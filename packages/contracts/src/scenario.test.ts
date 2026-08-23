import { describe, it, expect } from 'vitest';
import {
  SCENARIO_CATALOG,
  validateScenarioEvidence,
  type ScenarioKind,
  EnvFileProbeEvidenceSchema,
  WordpressConfigProbeEvidenceSchema,
  SuspiciousIpBurstEvidenceSchema,
  SipInviteFloodEvidenceSchema,
  TokenTamperEvidenceSchema,
  PathTraversalProbeEvidenceSchema,
  DecoyCredentialUseEvidenceSchema,
} from './scenario.js';

describe('Scenario Catalog & Evidence Validation', () => {
  const allKinds: ScenarioKind[] = [
    'ENV_FILE_PROBE',
    'WORDPRESS_CONFIG_PROBE',
    'SUSPICIOUS_IP_BURST',
    'SIP_INVITE_FLOOD',
    'TOKEN_TAMPER',
    'PATH_TRAVERSAL_PROBE',
    'DECOY_CREDENTIAL_USE',
  ];

  it('contains valid catalog entries for every scenario kind', () => {
    for (const kind of allKinds) {
      const preset = SCENARIO_CATALOG[kind];
      expect(preset).toBeDefined();
      expect(preset.kind).toBe(kind);
      expect(preset.title.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.expectedPolicy.length).toBeGreaterThan(0);
      expect(preset.allowedActions.length).toBeGreaterThan(0);
      expect(preset.maxRiskScore).toBeGreaterThanOrEqual(0);
      expect(preset.maxRiskScore).toBeLessThanOrEqual(100);
      expect(preset.defaultTtlSeconds).toBeGreaterThan(0);
      expect(preset.maxTtlSeconds).toBeGreaterThanOrEqual(preset.defaultTtlSeconds);

      // Default evidence must validate
      const validation = validateScenarioEvidence(kind, preset.defaultEvidence);
      expect(validation.success).toBe(true);
    }
  });

  describe('ENV_FILE_PROBE', () => {
    it('accepts valid .env probes', () => {
      const valid = {
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
      };
      const res = EnvFileProbeEvidenceSchema.safeParse(valid);
      expect(res.success).toBe(true);
    });

    it('rejects non-.env probes and extra fields', () => {
      const invalidPath = {
        requestedPath: '/index.html',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
      };
      expect(EnvFileProbeEvidenceSchema.safeParse(invalidPath).success).toBe(false);

      const extraFields = {
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
        untrustedExtraField: 'dummy',
      };
      expect(EnvFileProbeEvidenceSchema.safeParse(extraFields).success).toBe(false);
    });
  });

  describe('WORDPRESS_CONFIG_PROBE', () => {
    it('accepts wp-config probes', () => {
      const valid = {
        requestedPath: '/wp-config.php.bak',
        httpMethod: 'GET',
        userAgent: 'dummy-scanner/1.0',
        sourceIp: '198.51.100.26',
        matchedString: 'wp-config.php.bak',
        isPositiveMatch: true,
      };
      expect(WordpressConfigProbeEvidenceSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects invalid IP addresses', () => {
      const invalidIp = {
        requestedPath: '/wp-config.php',
        httpMethod: 'GET',
        userAgent: 'dummy-scanner/1.0',
        sourceIp: '999.999.999.999',
        matchedString: 'wp-config.php',
        isPositiveMatch: true,
      };
      expect(WordpressConfigProbeEvidenceSchema.safeParse(invalidIp).success).toBe(false);
    });
  });

  describe('SUSPICIOUS_IP_BURST', () => {
    it('accepts valid volumetric burst evidence', () => {
      const valid = {
        sourceIp: '198.51.100.27',
        burstCount: 500,
        windowSeconds: 10,
        sampledEndpoints: ['/api/v1/auth', '/admin'],
        isPositiveMatch: true,
      };
      expect(SuspiciousIpBurstEvidenceSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects negative or out-of-bound burst counts', () => {
      const invalid = {
        sourceIp: '198.51.100.27',
        burstCount: -5,
        windowSeconds: 10,
        sampledEndpoints: ['/api/v1/auth'],
        isPositiveMatch: true,
      };
      expect(SuspiciousIpBurstEvidenceSchema.safeParse(invalid).success).toBe(false);
    });
  });

  describe('SIP_INVITE_FLOOD', () => {
    it('accepts valid SIP flood evidence with sip: URI', () => {
      const valid = {
        sourceIp: '198.51.100.28',
        sipCallId: 'call-dummy-12345@198.51.100.28',
        inviteCount: 2000,
        targetUri: 'sip:pbx.example.com:5060',
        isPositiveMatch: true,
      };
      expect(SipInviteFloodEvidenceSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects targetUri not starting with sip:', () => {
      const invalid = {
        sourceIp: '198.51.100.28',
        sipCallId: 'call-dummy-12345@198.51.100.28',
        inviteCount: 2000,
        targetUri: 'http://pbx.example.com:5060',
        isPositiveMatch: true,
      };
      expect(SipInviteFloodEvidenceSchema.safeParse(invalid).success).toBe(false);
    });
  });

  describe('TOKEN_TAMPER', () => {
    it('accepts valid tampered token evidence', () => {
      const valid = {
        sourceIp: '198.51.100.29',
        targetedEndpoint: '/api/v1/operator/actions',
        tamperedClaims: ['role:admin'],
        tokenPrefix: 'dummy-token-prefix',
        isPositiveMatch: true,
      };
      expect(TokenTamperEvidenceSchema.safeParse(valid).success).toBe(true);
    });
  });

  describe('PATH_TRAVERSAL_PROBE', () => {
    it('accepts path traversal targeting sensitive files', () => {
      const valid = {
        requestedPath: '/static/../../../../etc/passwd',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.30',
        isPositiveMatch: true,
      };
      expect(PathTraversalProbeEvidenceSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects benign paths without traversal markers', () => {
      const invalid = {
        requestedPath: '/static/app.js',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.30',
        isPositiveMatch: true,
      };
      expect(PathTraversalProbeEvidenceSchema.safeParse(invalid).success).toBe(false);
    });
  });

  describe('DECOY_CREDENTIAL_USE', () => {
    it('accepts valid decoy credential evidence with mock-admin-decoy', () => {
      const valid = {
        sourceIp: '198.51.100.31',
        usedDecoyCredential: true,
        decoyIdentifier: 'mock-admin-decoy',
        targetAsset: 'admin-portal',
        failedLoginCount: 1,
        isPositiveMatch: true,
      };
      expect(DecoyCredentialUseEvidenceSchema.safeParse(valid).success).toBe(true);
    });
  });

  describe('Payload Bounds & Negative Controls', () => {
    it('rejects contradictory positive and negative-control markers', () => {
      const contradictory = {
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
        isNegativeControl: true,
      };
      expect(validateScenarioEvidence('ENV_FILE_PROBE', contradictory).success).toBe(false);
    });

    it('accepts an internally consistent negative control', () => {
      const negative = {
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'not-a-real-scanner/1.0',
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: false,
        isNegativeControl: true,
      };
      expect(validateScenarioEvidence('ENV_FILE_PROBE', negative).success).toBe(true);
    });

    it('rejects payloads exceeding max nesting depth', () => {
      const deeplyNested = { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } };
      const validation = validateScenarioEvidence('ENV_FILE_PROBE', deeplyNested);
      expect(validation.success).toBe(false);
      if (!validation.success) {
        expect(validation.error).toContain('nesting depth');
      }
    });

    it('rejects payloads exceeding max string length or key count', () => {
      const hugeString = {
        requestedPath: '/.env',
        httpMethod: 'GET',
        userAgent: 'a'.repeat(600),
        sourceIp: '198.51.100.25',
        matchedString: '.env',
        isPositiveMatch: true,
      };
      const validation = validateScenarioEvidence('ENV_FILE_PROBE', hugeString);
      expect(validation.success).toBe(false);
    });
  });

  describe('Comprehensive Scenario Matrix (All 7 Scenarios)', () => {
    for (const kind of allKinds) {
      describe(`Scenario: ${kind}`, () => {
        const preset = SCENARIO_CATALOG[kind];

        it('accepts valid positive evidence', () => {
          const res = validateScenarioEvidence(kind, preset.defaultEvidence);
          expect(res.success).toBe(true);
        });

        it('accepts consistent negative-control evidence (except DECOY_CREDENTIAL_USE which is strictly positive canary)', () => {
          if (kind === 'DECOY_CREDENTIAL_USE') {
            const negative = {
              ...preset.defaultEvidence,
              isPositiveMatch: false,
              isNegativeControl: true,
            };
            expect(validateScenarioEvidence(kind, negative).success).toBe(false);
          } else {
            const negative = {
              ...preset.defaultEvidence,
              isPositiveMatch: false,
              isNegativeControl: true,
            };
            expect(validateScenarioEvidence(kind, negative).success).toBe(true);
          }
        });

        it('rejects contradictory evidence (positiveMatch: true + negativeControl: true)', () => {
          const contradictory = {
            ...preset.defaultEvidence,
            isPositiveMatch: true,
            isNegativeControl: true,
          };
          expect(validateScenarioEvidence(kind, contradictory).success).toBe(false);
        });

        it('rejects oversized payload strings', () => {
          const oversized = {
            ...preset.defaultEvidence,
            oversizedProp: 'x'.repeat(1000),
          };
          expect(validateScenarioEvidence(kind, oversized).success).toBe(false);
        });

        it('rejects wrong-scenario evidence validation', () => {
          const otherKind: ScenarioKind =
            kind === 'ENV_FILE_PROBE' ? 'SUSPICIOUS_IP_BURST' : 'ENV_FILE_PROBE';
          const wrongEvidence = SCENARIO_CATALOG[otherKind].defaultEvidence;
          expect(validateScenarioEvidence(kind, wrongEvidence).success).toBe(false);
        });
      });
    }
  });
});
