import { basename } from 'node:path';

export interface SecretFinding {
  file: string;
  line?: number;
  reason: string;
}

interface SecretPattern {
  reason: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    reason: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  { reason: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    reason: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  },
  { reason: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { reason: 'Stripe live secret', pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { reason: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { reason: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  {
    reason: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
];

const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:]+):([^\s/@]+)@([^\s/:]+)/i;

const GENERIC_SECRET =
  /(?:api[_-]?(?:key|secret)|client[_-]?secret|access[_-]?(?:key|token)|auth(?:entication)?[_-]?(?:key|token)|authorization|jwt[_-]?secret|operator[_-]?token|private[_-]?key|security[_-]?key|secret[_-]?key|password|passwd)\s*[:=]\s*(?:"([^"]{12,})"|'([^']{12,})'|`([^`]{12,})`|([A-Za-z0-9_./+=-]{16,}))/i;

const PLACEHOLDER_MARKERS = [
  'change-me',
  'changeme',
  'dummy',
  'example',
  'placeholder',
  'process.env',
  'import.meta.env',
  'fake',
  'fictional',
  'demo',
  'local-only',
  'not-a-real',
  'redacted',
  'replace-me',
  'test-secret',
  'test-',
  'test_',
  'your-',
  'your_',
  '${',
  'config.',
  'this.',
];

const EXACT_PLACEHOLDERS = new Set([
  'falseroute',
  'local',
  'password',
  'password123',
  'pass',
  'test',
  'user',
]);

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    EXACT_PLACEHOLDERS.has(normalized) ||
    PLACEHOLDER_MARKERS.some((placeholder) => normalized.includes(placeholder)) ||
    /^x+$/i.test(value)
  );
}

export function isForbiddenSecretFile(file: string): boolean {
  const fileBasename = basename(file).toLowerCase();
  if (fileBasename.startsWith('.env') && fileBasename.endsWith('.example')) return false;
  if (fileBasename === '.env' || fileBasename.startsWith('.env.')) return true;

  return /(?:^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:key|pem|p12|pfx|jks|keystore))$/i.test(
    fileBasename,
  );
}

function findLineReason(line: string): string | undefined {
  const knownSecret = SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
  if (knownSecret) return knownSecret.reason;

  const credentialUrl = line.match(CREDENTIAL_URL);
  if (credentialUrl) {
    const [, username = '', password = ''] = credentialUrl;
    const explicitPlaceholder = isPlaceholder(username) && isPlaceholder(password);
    if (!explicitPlaceholder) return 'credential-bearing URL';
  }

  const genericSecret = line.match(GENERIC_SECRET);
  const value = genericSecret?.slice(1).find((candidate) => candidate !== undefined);
  if (value && !isPlaceholder(value)) return 'probable hard-coded credential';

  return undefined;
}

export function scanSecretText(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const [index, line] of content.split('\n').entries()) {
    const reason = findLineReason(line);
    if (reason) findings.push({ file, line: index + 1, reason });
  }

  return findings;
}
