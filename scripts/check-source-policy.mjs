import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();

console.log('Running source policy checks...');

let hasErrors = false;
let warningCount = 0;

function error(msg) {
  console.error(`❌ [check-source-policy] ${msg}`);
  hasErrors = true;
}

function warn(msg) {
  console.warn(`⚠️  [check-source-policy] ${msg}`);
  warningCount++;
}

function success(msg) {
  console.log(`✅ [check-source-policy] ${msg}`);
}

// Allowlisted files with documented justification (empty by default)
const LINE_LIMIT_ALLOWLIST = new Set([]);

// Find first-party source files in apps/*, packages/*, tests/*, scripts/*
const SOURCE_ROOTS = ['apps', 'packages', 'tests', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isGenerated(filename, fullPath) {
  return (
    filename.includes('.generated.') ||
    filename.endsWith('.d.ts') ||
    fullPath.includes('/dist/') ||
    fullPath.includes('/build/') ||
    fullPath.includes('/node_modules/') ||
    fullPath.includes('/coverage/') ||
    fullPath.includes('/prisma/migrations/') ||
    fullPath.includes('/generated/') ||
    fullPath.includes('/.turbo/')
  );
}

function findSourceFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === 'generated' ||
        entry.name === '.turbo'
      ) {
        continue;
      }

      results.push(...findSourceFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (SOURCE_EXTENSIONS.has(ext) && !isGenerated(entry.name, fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const allSourceFiles = [];
for (const subDir of SOURCE_ROOTS) {
  const fullSubDir = resolve(ROOT, subDir);
  allSourceFiles.push(...findSourceFiles(fullSubDir));
}

if (allSourceFiles.length === 0) {
  success('No first-party application source files found during Phase 2 (clean skip).');
  process.exit(0);
}

console.log(`Scanning ${allSourceFiles.length} first-party source files...`);

// Structured tracking reference: issue (#123, repo#123), Jira/issue key (TICKET-1, FR-123), ADR (ADR-0001), phase (PHASE-3), or URL (https://...)
const SINGLE_TRACKING_ID_SRC =
  '(?:#\\d+|[a-zA-Z0-9_.-]+#\\d+|[A-Z][A-Z0-9_]+-\\d+|ADR-\\d{4}|PHASE-\\d+|https?:\\/\\/[^\\s)\\]]+)';
const TRACKING_ID_LIST_SRC = `${SINGLE_TRACKING_ID_SRC}(?:\\s*,\\s*${SINGLE_TRACKING_ID_SRC})*`;

// Tracked markers: TODO(#123), FIXME(TICKET-1), HACK(ADR-0001), TODO [PHASE-3], TODO: [TICKET-123], TODO: #123
const TRACKED_MARKER_REGEX = new RegExp(
  `\\b(TODO|FIXME|HACK|XXX|BUG|TEMP|TBD)(?:\\s*\\(\\s*${TRACKING_ID_LIST_SRC}\\s*\\)|\\s*\\[\\s*${TRACKING_ID_LIST_SRC}\\s*\\]|:\\s*\\[\\s*${TRACKING_ID_LIST_SRC}\\s*\\]|:\\s*\\(\\s*${TRACKING_ID_LIST_SRC}\\s*\\)|:\\s*${SINGLE_TRACKING_ID_SRC}\\b)`,
);
const ANY_MARKER_REGEX = /\b(TODO|FIXME|HACK|XXX|BUG|TEMP|TBD)\b/;

// Prohibited placeholder product values in production source code
const PROHIBITED_PRODUCT_VALUES = [
  /mock-data-placeholder/i,
  /fake-secret/i,
  /placeholder-decision/i,
  /dummy-event/i,
  /sample-event-data/i,
];

function getContractExportNames() {
  const indexPath = resolve(ROOT, 'packages/contracts/src/index.ts');
  if (!existsSync(indexPath)) return new Set();
  const content = readFileSync(indexPath, 'utf8');
  const sourceFile = ts.createSourceFile(indexPath, content, ts.ScriptTarget.Latest, true);

  const exportNames = new Set();
  function visit(node) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        exportNames.add(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return exportNames;
}

const CANONICAL_CONTRACT_NAMES = getContractExportNames();

for (const filePath of allSourceFiles) {
  const relPath = filePath.replace(ROOT + '/', '');
  // This checker contains the marker and prohibited-value patterns it enforces.
  const isPolicyChecker = relPath === 'scripts/check-source-policy.mjs';
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const lineCount = lines.length;

  // 1. Line limits
  if (lineCount > 500 && !LINE_LIMIT_ALLOWLIST.has(relPath)) {
    error(
      `File ${relPath} has ${lineCount} lines (exceeds 500 line hard limit without allowlist justification).`,
    );
  } else if (lineCount > 300) {
    warn(
      `File ${relPath} has ${lineCount} lines (approaching 300 line review threshold; consider splitting).`,
    );
  }

  // 2. Prohibited placeholders & untracked markers in production code (skip tests)
  const isTest =
    relPath.includes('.test.') || relPath.includes('.spec.') || relPath.startsWith('tests/');
  if (!isTest && !isPolicyChecker) {
    lines.forEach((line, idx) => {
      // Check prohibited fake values
      for (const pattern of PROHIBITED_PRODUCT_VALUES) {
        if (pattern.test(line)) {
          error(
            `File ${relPath}:${idx + 1} contains prohibited placeholder value: "${line.trim()}"`,
          );
        }
      }

      // Check engineering markers
      if (ANY_MARKER_REGEX.test(line)) {
        if (!TRACKED_MARKER_REGEX.test(line)) {
          error(
            `File ${relPath}:${idx + 1} contains untracked marker without tracking reference (e.g. TODO(#issue) or TODO [ADR]): "${line.trim()}"`,
          );
        }
      }
    });
  }

  // 3. Prohibit duplicate contract declarations outside packages/contracts using AST canonical-name collision inspection
  const isContractsPackage = relPath.startsWith('packages/contracts/');
  if (
    !isContractsPackage &&
    !isTest &&
    (extname(filePath) === '.ts' ||
      extname(filePath) === '.tsx' ||
      extname(filePath) === '.js' ||
      extname(filePath) === '.mjs')
  ) {
    try {
      const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

      function visitNode(node) {
        let declaredName = null;
        if (
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isEnumDeclaration(node)
        ) {
          declaredName = node.name?.text;
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          declaredName = node.name.text;
        }

        if (declaredName && CANONICAL_CONTRACT_NAMES.has(declaredName)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          error(
            `File ${relPath}:${line + 1}:${character + 1} structurally declares canonical contract '${declaredName}'. Import canonical schema/type from '@false-route/contracts' instead.`,
          );
        }

        ts.forEachChild(node, visitNode);
      }

      visitNode(sourceFile);
    } catch (parseErr) {
      error(`Failed to parse AST for ${relPath}: ${parseErr.message}`);
    }
  }
}

if (!hasErrors) {
  success(
    `Source policy validated across ${allSourceFiles.length} files (${warningCount} warnings).`,
  );
}

if (hasErrors) {
  console.error('\ncheck-source-policy failed with errors.');
  process.exit(1);
} else {
  console.log('\ncheck-source-policy passed successfully.');
}
