import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();

console.log('Running public documentation boundary checks...');

let hasErrors = false;

function error(msg) {
  console.error(`❌ [check-docs] ${msg}`);
  hasErrors = true;
}

function success(msg) {
  console.log(`✅ [check-docs] ${msg}`);
}

// Public Markdown is an explicit allowlist. Everything else remains local and ignored.
const publicDocs = [
  'README.md',
  'docs/architecture/engineering-principles.md',
  'docs/architecture/frontend.md',
  'docs/architecture/overview.md',
  'docs/architecture/threat-model.md',
  'docs/architecture/quality-gates.md',
];

for (const relPath of publicDocs) {
  const fullPath = resolve(ROOT, relPath);
  if (!existsSync(fullPath)) {
    error(`Required document is missing: ${relPath}`);
  }
}
if (!hasErrors) {
  success('All approved public Markdown documents exist.');
}

// 3. Local Markdown links resolve
function findMarkdownFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '.turbo' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      results.push(fullPath);
    }
  }
  return results;
}

const mdFiles = publicDocs.map((file) => resolve(ROOT, file));
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

let brokenLinks = 0;

for (const filePath of mdFiles) {
  const content = readFileSync(filePath, 'utf8');
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const target = match[2].trim();
    // Skip web URLs, email links, pure in-page anchors, or special schemes
    if (
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:') ||
      target.startsWith('#') ||
      target.startsWith('file://')
    ) {
      continue;
    }

    // Strip anchor fragment if present
    const cleanTarget = target.split('#')[0];
    if (!cleanTarget) {
      continue;
    }

    const targetPath = resolve(dirname(filePath), cleanTarget);
    if (!existsSync(targetPath)) {
      error(
        `Broken markdown link in ${filePath.replace(ROOT + '/', '')}: '${target}' does not resolve to a file.`,
      );
      brokenLinks++;
    }
  }
}

if (brokenLinks === 0) {
  success(`Validated local markdown links across ${mdFiles.length} files.`);
}

function gitIgnoreStatus(file) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', file], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  error(`Git ignore check failed for ${file}: ${result.stderr.toString().trim()}`);
  return null;
}

const publicDocSet = new Set(publicDocs);
for (const file of publicDocs) {
  if (gitIgnoreStatus(file) === true) {
    error(`Approved public Markdown is ignored by Git: ${file}`);
  }
}

const allMarkdownFiles = findMarkdownFiles(ROOT);
for (const filePath of allMarkdownFiles) {
  const relPath = filePath.replace(`${ROOT}/`, '');
  if (!publicDocSet.has(relPath) && gitIgnoreStatus(relPath) === false) {
    error(`Internal Markdown is not ignored by Git: ${relPath}`);
  }
}

if (!hasErrors) {
  success('Public Markdown is allowlisted and all other Markdown is ignored by Git.');
}

if (hasErrors) {
  console.error('\ncheck-docs failed with errors.');
  process.exit(1);
} else {
  console.log('\ncheck-docs passed successfully.');
}
