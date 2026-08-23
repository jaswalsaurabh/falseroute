import { execSync } from 'node:child_process';

console.log('==============================================');
console.log('FalseRoute Repository Quality Gate Checks');
console.log('==============================================\n');

const checks = [
  { name: 'Documentation & Agent Rules', script: 'scripts/check-docs.mjs' },
  { name: 'Dependency & Version Policy', script: 'scripts/check-dependencies.mjs' },
  { name: 'Source Size & Placeholder Policy', script: 'scripts/check-source-policy.mjs' },
  { name: 'Design Token Guardrails', script: 'scripts/check-design-tokens.mjs' },
  { name: 'Cloud Run Deployment Templates', script: 'scripts/validate-cloud-run-templates.ts' },
  { name: 'Secret & Credential Policy', script: 'scripts/check-secrets.ts --all' },
  { name: 'Public Infrastructure Configuration', script: 'scripts/public-config-check.ts --all' },
];

let failed = false;

for (const check of checks) {
  console.log(`\n--- Running Check: ${check.name} ---`);
  try {
    execSync(`node ${check.script}`, { stdio: 'inherit' });
  } catch (_err) {
    console.error(`\n❌ Failed check: ${check.name}`);
    failed = true;
  }
}

console.log('\n==============================================');
if (failed) {
  console.error('❌ Repository quality gate checks FAILED.');
  console.log('==============================================');
  process.exit(1);
} else {
  console.log('✅ All repository quality gate checks PASSED.');
  console.log('==============================================');
}
