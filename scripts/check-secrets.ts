import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isForbiddenSecretFile, scanSecretText, type SecretFinding } from './secret-scanner.ts';

type ScanMode = 'all' | 'staged' | 'history';

const HISTORY_MAX_COMMITS = 256;
const HISTORY_MAX_OBJECTS = 50_000;
const HISTORY_MAX_BLOBS = 10_000;
const HISTORY_MAX_BYTES = 64 * 1024 * 1024;

interface HistoricalBlob {
  oid: string;
  paths: string[];
  size: number;
}

interface HistoryScanResult {
  findings: SecretFinding[];
  blobs: number;
  paths: number;
  bytes: number;
  bounded: boolean;
}

function runGit(
  args: string[],
  encoding: BufferEncoding | 'buffer' = 'utf8',
  input?: string | Buffer,
): string | Buffer {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    input: encoding === 'buffer' && typeof input === 'string' ? Buffer.from(input) : input,
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

function getHistoricalBlobs(): { blobs: HistoricalBlob[]; bounded: boolean } {
  const commitCount = Number((runGit(['rev-list', '--all', '--count'], 'utf8') as string).trim());
  const objectLines = (
    runGit(
      ['rev-list', '--objects', '--all', `--max-count=${HISTORY_MAX_COMMITS}`],
      'utf8',
    ) as string
  ).split('\n');
  const pathsByObject = new Map<string, string[]>();
  let bounded = commitCount > HISTORY_MAX_COMMITS;

  for (const line of objectLines) {
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;

    const oid = line.slice(0, separator);
    const path = line.slice(separator + 1);
    if (!/^[0-9a-f]{40,64}$/.test(oid) || path.length === 0) continue;

    const paths = pathsByObject.get(oid);
    if (paths) {
      if (!paths.includes(path)) paths.push(path);
      continue;
    }

    if (pathsByObject.size >= HISTORY_MAX_OBJECTS) {
      bounded = true;
      break;
    }
    pathsByObject.set(oid, [path]);
  }

  const objectIds = [...pathsByObject.keys()];
  if (objectIds.length === 0) return { blobs: [], bounded };

  const metadata = (
    runGit(
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      'utf8',
      `${objectIds.join('\n')}\n`,
    ) as string
  ).split('\n');
  const blobs: HistoricalBlob[] = [];
  let bytes = 0;

  for (const line of metadata) {
    const [oid, type, sizeText] = line.split(' ');
    if (type !== 'blob' || !oid || !sizeText) continue;

    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    if (blobs.length >= HISTORY_MAX_BLOBS || bytes + size > HISTORY_MAX_BYTES) {
      bounded = true;
      break;
    }

    const paths = pathsByObject.get(oid);
    if (!paths) continue;
    blobs.push({ oid, paths, size });
    bytes += size;
  }

  return { blobs, bounded };
}

function scanHistoricalBlobs(): HistoryScanResult {
  const history = getHistoricalBlobs();
  const { blobs } = history;
  let bounded = history.bounded;
  if (blobs.length === 0) return { findings: [], blobs: 0, paths: 0, bytes: 0, bounded };

  const output = runGit(
    ['cat-file', '--batch'],
    'buffer',
    `${blobs.map(({ oid }) => oid).join('\n')}\n`,
  ) as Buffer;
  const findings: SecretFinding[] = [];
  let offset = 0;
  let scannedBytes = 0;
  let scannedBlobs = 0;
  let scannedPaths = 0;

  for (const blob of blobs) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) {
      bounded = true;
      break;
    }

    const [oid, type, sizeText] = output.subarray(offset, headerEnd).toString('utf8').split(' ');
    offset = headerEnd + 1;
    if (oid !== blob.oid || type !== 'blob' || !sizeText) {
      bounded = true;
      break;
    }

    const size = Number(sizeText);
    const contentEnd = offset + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      bounded = true;
      break;
    }

    const content = output.subarray(offset, contentEnd);
    offset = contentEnd + (output[contentEnd] === 10 ? 1 : 0);
    scannedBlobs += 1;
    scannedBytes += content.length;
    scannedPaths += blob.paths.length;

    const forbiddenPath = blob.paths.find((path) => isForbiddenSecretFile(path));
    if (forbiddenPath) {
      findings.push({
        file: forbiddenPath,
        reason: 'secret-bearing file type must not be committed',
      });
    }
    if (content.includes(0)) continue;

    findings.push(...scanSecretText(blob.paths[0]!, content.toString('utf8')));
  }

  return {
    findings,
    blobs: scannedBlobs,
    paths: scannedPaths,
    bytes: scannedBytes,
    bounded,
  };
}

function parseMode(args: string[]): ScanMode {
  if (
    args.length !== 1 ||
    (args[0] !== '--all' && args[0] !== '--staged' && args[0] !== '--history')
  ) {
    throw new Error('Usage: node scripts/check-secrets.ts --all|--staged|--history');
  }
  if (args[0] === '--staged') return 'staged';
  if (args[0] === '--history') return 'history';
  return 'all';
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const history = mode === 'history' ? scanHistoricalBlobs() : null;
  const files = history ? [] : getFiles(mode);
  const findings = history ? history.findings : scanFiles(files, mode);

  if (findings.length > 0) {
    console.error(
      `Secret scan failed for ${
        mode === 'staged'
          ? 'staged changes'
          : mode === 'history'
            ? 'historical repository blobs'
            : 'the repository'
      }:`,
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

  if (history) {
    if (history.bounded) {
      console.error(
        `Secret history scan incomplete after ${history.blobs} unique historical blobs, ${history.bytes} bytes scanned; refusing to pass with configured bounds.`,
      );
      process.exit(1);
    }
    console.log(
      `Secret scan passed (${history.blobs} unique historical blobs, ${history.paths} historical paths, ${history.bytes} bytes scanned).`,
    );
    return;
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
