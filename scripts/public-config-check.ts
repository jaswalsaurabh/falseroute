import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PublicConfigFinding {
  readonly file: string;
  readonly line?: number;
  readonly reason: string;
}

type ScanMode = 'all' | 'staged';

const PRIVATE_VARIABLES = new Set([
  'project_id',
  'project_number',
  'domain_name',
  'technical_owner',
  'security_approver',
  'incident_contact_email',
]);

const SAFE_PLACEHOLDER =
  /(?:example|dummy|placeholder|change[-_]?me|your[-_]?|not[-_]?a[-_]?real)/i;

function runGit(args: string[], encoding: BufferEncoding | 'buffer' = 'utf8'): string | Buffer {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNullSeparated(output: string | Buffer): string[] {
  return output.toString('utf8').split('\0').filter(Boolean);
}

function getFiles(mode: ScanMode): string[] {
  const args =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  return parseNullSeparated(runGit(args, 'buffer'));
}

function readFileForMode(file: string, mode: ScanMode): Buffer | null {
  try {
    if (mode === 'staged') return runGit(['show', `:0:${file}`], 'buffer') as Buffer;
    const absolutePath = resolve(process.cwd(), file);
    return existsSync(absolutePath) ? readFileSync(absolutePath) : null;
  } catch {
    return null;
  }
}

function isTerraformConfig(file: string): boolean {
  return /^infrastructure\/terraform\/.*\.(?:tf|tfvars\.example|hcl)$/i.test(file);
}

function isSafePlaceholder(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/["'`]$/u, '')
    .replace(/^["'`]/u, '');
  return normalized === '' || SAFE_PLACEHOLDER.test(normalized) || normalized === 'null';
}

export function scanPublicConfigText(file: string, content: string): PublicConfigFinding[] {
  if (!isTerraformConfig(file)) return [];

  const findings: PublicConfigFinding[] = [];
  const lines = content.split('\n');

  if (/backend\s+"gcs"\s*\{/u.test(content)) {
    const bucketLine = lines.findIndex((line) => /^\s*bucket\s*=\s*"[^"]+"/u.test(line));
    if (bucketLine >= 0) {
      findings.push({
        file,
        line: bucketLine + 1,
        reason: 'Terraform state bucket must be supplied through private backend configuration',
      });
    }
  }

  let variableName: string | undefined;
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    const declaration = line.match(/^\s*variable\s+"([^"]+)"\s*\{/u);
    if (declaration) {
      variableName = declaration[1];
      depth = 1;
      continue;
    }

    if (!variableName) continue;
    const defaultValue = line.match(/^\s*default\s*=\s*(.+?)(?:\s+#.*)?$/u);
    if (
      defaultValue &&
      PRIVATE_VARIABLES.has(variableName) &&
      !isSafePlaceholder(defaultValue[1]!)
    ) {
      findings.push({
        file,
        line: index + 1,
        reason: `environment-specific default for '${variableName}' must be supplied privately`,
      });
    }

    depth += (line.match(/\{/gu) ?? []).length;
    depth -= (line.match(/\}/gu) ?? []).length;
    if (depth <= 0) variableName = undefined;
  }

  return findings;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--all', '--staged'].includes(args[0]!)) {
    throw new Error('Usage: node scripts/public-config-check.ts --all|--staged');
  }
  const mode = args[0] as ScanMode;
  const findings = getFiles(mode)
    .filter(isTerraformConfig)
    .flatMap((file) => {
      const content = readFileForMode(file, mode);
      return content ? scanPublicConfigText(file, content.toString('utf8')) : [];
    });

  if (findings.length > 0) {
    console.error(
      `Public configuration check failed for ${mode === 'staged' ? 'staged changes' : 'the repository'}:`,
    );
    for (const finding of findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  - ${location}: ${finding.reason}`);
    }
    process.exit(1);
  }

  console.log(
    `Public configuration check passed (${mode === 'staged' ? 'staged' : 'repository'} Terraform files).`,
  );
}

if (process.argv[1]?.endsWith('/public-config-check.ts')) {
  try {
    main();
  } catch (error) {
    console.error(
      `[public-config-check] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
