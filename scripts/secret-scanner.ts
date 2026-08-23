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

const EMAIL_ADDRESS =
  /\b([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)*|localhost)\b/i;

const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

const SYNTHETIC_EMAIL_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org'];

const GENERIC_SECRET =
  /(?:api[_-]?(?:key|secret)|client[_-]?secret|access[_-]?(?:key|token)|auth(?:entication)?[_-]?(?:key|token)|authorization|jwt[_-]?secret|operator[_-]?token|private[_-]?key|security[_-]?key|secret[_-]?key|password|passwd)\s*[:=]\s*(?:"([^"]{12,})"|'([^']{12,})'|`([^`]{12,})`|([A-Za-z0-9_./+=-]{16,}))/i;

const SYNTHETIC_MARKER =
  /^(?:change[-_]?me|changeme|dummy|example|fake|fictional|placeholder|demo|local[-_]only|not[-_]a[-_]real|redacted|replace[-_]me|test|your)(?:$|[-_.])/i;

const COMPOUND_SYNTHETIC_MARKER =
  /(?:^|[-_])(?:integration|system|autonomous|local|smoke)[-_]test(?:$|[-_.])/i;

const PLACEHOLDER_EXPRESSIONS = ['process.env', 'import.meta.env', '${'] as const;

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
  const normalized = value
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return (
    EXACT_PLACEHOLDERS.has(normalized) ||
    SYNTHETIC_MARKER.test(normalized) ||
    COMPOUND_SYNTHETIC_MARKER.test(normalized) ||
    PLACEHOLDER_EXPRESSIONS.some((expression) => normalized.includes(expression)) ||
    /^x+$/i.test(value)
  );
}

function isSyntheticEmail(localPart: string, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  return (
    normalizedDomain === 'localhost' ||
    normalizedDomain.endsWith('.invalid') ||
    SYNTHETIC_EMAIL_DOMAINS.some(
      (syntheticDomain) =>
        normalizedDomain === syntheticDomain || normalizedDomain.endsWith(`.${syntheticDomain}`),
    ) ||
    isPlaceholder(localPart)
  );
}

function isSymbolicReference(value: string): boolean {
  return /^(?:process\.env|import\.meta\.env|config|this|var|local|random_password|module)\.[A-Za-z_][A-Za-z0-9_.-]*$/.test(
    value,
  );
}

export function isForbiddenSecretFile(file: string): boolean {
  const fileBasename = basename(file).toLowerCase();
  if (fileBasename.startsWith('.env') && fileBasename.endsWith('.example')) return false;
  if (fileBasename.endsWith('.tfvars.example')) return false;
  if (fileBasename === '.env' || fileBasename.startsWith('.env.')) return true;
  if (
    fileBasename.endsWith('.tfvars') ||
    fileBasename.endsWith('.tfvars.json') ||
    fileBasename.endsWith('.tfstate') ||
    fileBasename.includes('.tfstate.') ||
    fileBasename.endsWith('.tfplan') ||
    fileBasename === 'tfplan'
  ) {
    return true;
  }

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
  const isUnquotedSymbolicReference =
    genericSecret?.[4] !== undefined && value !== undefined && isSymbolicReference(value);
  const isInterpolation = value !== undefined && /^\$\{[A-Za-z_][A-Za-z0-9_.-]*\}$/.test(value);
  if (value && !isPlaceholder(value) && !isUnquotedSymbolicReference && !isInterpolation) {
    return 'probable hard-coded credential';
  }

  const emailAddress = line.match(EMAIL_ADDRESS);
  const [, localPart = '', domain = ''] = emailAddress ?? [];
  if (
    emailAddress &&
    PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase()) &&
    !isSyntheticEmail(localPart, domain)
  ) {
    return 'personal email address';
  }

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
