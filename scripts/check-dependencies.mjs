import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();

console.log('Running dependency policy and workspace checks...');

let hasErrors = false;

function error(msg) {
  console.error(`❌ [check-dependencies] ${msg}`);
  hasErrors = true;
}

function success(msg) {
  console.log(`✅ [check-dependencies] ${msg}`);
}

// Strict exact semver: digits.digits.digits with no ranges, wildcards, or pre-release tags
const EXACT_SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// 1. Read root package.json, pnpm-workspace.yaml, .nvmrc
const rootPkgPath = resolve(ROOT, 'package.json');
if (!existsSync(rootPkgPath)) {
  error('Root package.json is missing.');
  process.exit(1);
}
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));

const nvmrcPath = resolve(ROOT, '.nvmrc');
if (!existsSync(nvmrcPath)) {
  error('.nvmrc is missing.');
} else {
  const nvmVersion = readFileSync(nvmrcPath, 'utf8').trim();
  if (rootPkg.engines?.node !== nvmVersion) {
    error(
      `Node version mismatch: package.json engines.node (${rootPkg.engines?.node}) != .nvmrc (${nvmVersion})`,
    );
  } else {
    success(`Node version alignment verified: ${nvmVersion}`);
  }
}

// Check packageManager and engines.pnpm
if (!rootPkg.packageManager) {
  error('packageManager field is missing in root package.json.');
} else {
  const pmVersion = rootPkg.packageManager.replace(/^pnpm@/, '');
  if (rootPkg.engines?.pnpm && rootPkg.engines.pnpm !== pmVersion) {
    error(
      `pnpm version mismatch: packageManager (${pmVersion}) != engines.pnpm (${rootPkg.engines.pnpm})`,
    );
  } else {
    success(`packageManager and engines.pnpm alignment verified: ${pmVersion}`);
  }
}

// 2. Read pnpm-workspace.yaml catalog
const workspaceYamlPath = resolve(ROOT, 'pnpm-workspace.yaml');
if (!existsSync(workspaceYamlPath)) {
  error('pnpm-workspace.yaml is missing.');
  process.exit(1);
}

const workspaceYaml = readFileSync(workspaceYamlPath, 'utf8');
const catalogEntries = {};
let inCatalog = false;

for (const line of workspaceYaml.split('\n')) {
  if (line.startsWith('catalog:')) {
    inCatalog = true;
    continue;
  }
  if (inCatalog) {
    if (line.match(/^[a-zA-Z]/) && !line.startsWith(' ')) {
      inCatalog = false;
      continue;
    }
    const match = line.match(/^\s+['"]?([^'":]+)['"]?:\s*['"]?([^'"]+)['"]?/);
    if (match) {
      catalogEntries[match[1]] = match[2].trim();
    }
  }
}

// Verify all catalog versions are strictly exact stable semver
for (const [pkg, ver] of Object.entries(catalogEntries)) {
  if (!EXACT_SEMVER_REGEX.test(ver)) {
    error(
      `Catalog entry for '${pkg}' has non-exact or pre-release version: '${ver}' (must strictly match X.Y.Z)`,
    );
  }
}
if (!hasErrors && Object.keys(catalogEntries).length > 0) {
  success(`Catalog verified: ${Object.keys(catalogEntries).length} exact, stable entries.`);
}

// 3. Verify all package manifests (root and workspaces)
function checkManifest(pkgPath, pkgJson, isRoot = false) {
  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
    ...pkgJson.peerDependencies,
    ...pkgJson.optionalDependencies,
  };

  for (const [dep, ver] of Object.entries(allDeps)) {
    if (ver.startsWith('workspace:')) {
      if (isRoot && dep !== '@false-route/typescript-config' && !ver.startsWith('workspace:*')) {
        error(`Root dependency '${dep}' has unapproved workspace specifier: '${ver}'`);
      }
      continue;
    }
    if (ver === 'catalog:') {
      // Valid catalog reference
      if (!catalogEntries[dep]) {
        error(
          `Package ${pkgPath}: references 'catalog:' for '${dep}' but '${dep}' is not in pnpm-workspace.yaml catalog`,
        );
      }
      continue;
    }
    if (!EXACT_SEMVER_REGEX.test(ver)) {
      error(
        `Package ${pkgPath}: direct dependency '${dep}' has unpinned/unapproved version '${ver}' (must be 'catalog:' or exact X.Y.Z)`,
      );
    } else if (catalogEntries[dep] && ver !== catalogEntries[dep]) {
      error(
        `Package ${pkgPath}: dependency '${dep}' version '${ver}' drifts from catalog version '${catalogEntries[dep]}'`,
      );
    }
  }
}

checkManifest('package.json', rootPkg, true);

// 4. Validate all workspace packages and ensure no silent omission of quality scripts
function checkWorkspaces(baseDir) {
  const fullDir = resolve(ROOT, baseDir);
  if (!existsSync(fullDir)) return;
  const entries = readdirSync(fullDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const workspaceDir = join(fullDir, entry.name);
      const manifestPath = join(workspaceDir, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const relManifest = `${baseDir}/${entry.name}/package.json`;

        if (!manifest.private) {
          error(`Workspace ${relManifest}: must set "private": true`);
        }
        if (manifest.type !== 'module') {
          error(`Workspace ${relManifest}: must set "type": "module"`);
        }

        checkManifest(relManifest, manifest, false);

        // If workspace contains TypeScript source files, enforce tsconfig and runnable quality scripts
        const srcDir = join(workspaceDir, 'src');
        if (existsSync(srcDir)) {
          const tsconfigPath = join(workspaceDir, 'tsconfig.json');
          if (!existsSync(tsconfigPath)) {
            error(
              `Workspace ${baseDir}/${entry.name} has src/ directory but is missing tsconfig.json`,
            );
          }
          if (!manifest.scripts?.build) {
            error(`Workspace ${relManifest} has src/ but is missing "build" script`);
          }
          if (!manifest.scripts?.typecheck) {
            error(`Workspace ${relManifest} has src/ but is missing "typecheck" script`);
          }
          if (!manifest.scripts?.lint) {
            error(`Workspace ${relManifest} has src/ but is missing "lint" script`);
          }
          if (!manifest.scripts?.test) {
            error(`Workspace ${relManifest} has src/ but is missing "test" script`);
          }
        }

        // Prohibit placeholder or fake scripts in all workspace manifests
        for (const [scriptName, scriptCmd] of Object.entries(manifest.scripts || {})) {
          if (
            typeof scriptCmd === 'string' &&
            (scriptCmd.startsWith('echo ') || scriptCmd.includes('exit 0'))
          ) {
            error(
              `Workspace ${relManifest}: script "${scriptName}" uses prohibited placeholder/echo command: "${scriptCmd}"`,
            );
          }
        }
      }
    }
  }
}

checkWorkspaces('packages');
checkWorkspaces('apps');
checkWorkspaces('tests');

if (hasErrors) {
  console.error('\ncheck-dependencies failed with errors.');
  process.exit(1);
} else {
  console.log('\ncheck-dependencies passed successfully.');
}
