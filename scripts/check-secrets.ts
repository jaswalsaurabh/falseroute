import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isForbiddenSecretFile, scanSecretText, type SecretFinding } from './secret-scanner.ts';

type ScanMode = 'all' | 'staged';

function runGit(args: string[], encoding: BufferEncoding | 'buffer' = 'utf8'): string | Buffer {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNullSeparated(output: string | Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((file) => file.length > 0);
}

function getFiles(mode: ScanMode): string[] {
  if (mode === 'staged') {
    return parseNullSeparated(
      runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], 'buffer'),
    );
  }

  return parseNullSeparated(
    runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], 'buffer'),
  );
}

function readFileForMode(file: string, mode: ScanMode): Buffer | null {
  try {
    if (mode === 'staged') {
      return runGit(['show', `:0:${file}`], 'buffer') as Buffer;
    }

    const absolutePath = resolve(process.cwd(), file);
    return existsSync(absolutePath) ? readFileSync(absolutePath) : null;
  } catch {
    return null;
  }
}

function scanFiles(files: string[], mode: ScanMode): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const file of files) {
    if (isForbiddenSecretFile(file)) {
      findings.push({ file, reason: 'secret-bearing file type must not be committed' });
    }

    const content = readFileForMode(file, mode);
    if (!content || content.includes(0)) continue;
    findings.push(...scanSecretText(file, content.toString('utf8')));
  }

  return findings;
}

function parseMode(args: string[]): ScanMode {
  if (args.length !== 1 || (args[0] !== '--all' && args[0] !== '--staged')) {
    throw new Error('Usage: node scripts/check-secrets.ts --all|--staged');
  }
  return args[0] === '--staged' ? 'staged' : 'all';
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const files = getFiles(mode);
  const findings = scanFiles(files, mode);

  if (findings.length > 0) {
    console.error(
      `Secret scan failed for ${mode === 'staged' ? 'staged changes' : 'the repository'}:`,
    );
    for (const finding of findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  - ${location}: ${finding.reason}`);
    }
    console.error(
      'Use explicit dummy/example markers for test credentials; never bypass a real finding.',
    );
    process.exit(1);
  }

  console.log(
    `Secret scan passed (${files.length} ${mode === 'staged' ? 'staged' : 'repository'} files).`,
  );
}

try {
  main();
} catch (error) {
  console.error(`[check-secrets] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
