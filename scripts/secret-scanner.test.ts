import assert from 'node:assert/strict';
import test from 'node:test';
import { isForbiddenSecretFile, scanSecretText } from './secret-scanner.ts';

test('rejects private environment, key, and Terraform state/vars files while allowing examples', () => {
  assert.equal(isForbiddenSecretFile('.env.production'), true);
  assert.equal(isForbiddenSecretFile('config/.env.example'), false);
  assert.equal(isForbiddenSecretFile('certificates/service.key'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/terraform.tfvars'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/staging.tfvars'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/staging.tfvars.json'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/terraform.tfvars.example'), false);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/terraform.tfstate'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/terraform.tfstate.backup'), true);
  assert.equal(isForbiddenSecretFile('infrastructure/terraform/tfplan'), true);
});

test('detects provider tokens without returning their values', () => {
  const token = ['ghp', 'a'.repeat(36)].join('_');
  const findings = scanSecretText('source.ts', `const token = "${token}";`);

  assert.deepEqual(findings, [{ file: 'source.ts', line: 1, reason: 'GitHub token' }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test('detects probable credentials and non-local credential URLs', () => {
  const credentialUrl = ['postgresql://service-user', 'sensitive-value@db.internal/app'].join(':');
  const credentialAssignment = ['password', '"sensitive-password-value"'].join(' = ');
  const content = [credentialAssignment, credentialUrl].join('\n');

  assert.deepEqual(scanSecretText('config.ts', content), [
    { file: 'config.ts', line: 1, reason: 'probable hard-coded credential' },
    { file: 'config.ts', line: 2, reason: 'credential-bearing URL' },
  ]);
});

test('allows explicit placeholders, local test connection strings, and Terraform symbolic references', () => {
  const content = [
    'password = "not-a-real-password"',
    'apiKey = process.env.GEMINI_API_KEY',
    'password = random_password.db_password.result',
    'operator_access_token = random_password.operator_access_token.result',
    'gemini_api_key = var.gemini_api_key',
    'secret_id = module.secrets.api_operator_token_secret_id',
    ['postgresql://example-user', 'dummy-password@127.0.0.1/app_test'].join(':'),
  ].join('\n');

  assert.deepEqual(scanSecretText('config.test.ts', content), []);
});

test('requires synthetic markers to be explicit rather than merely embedded', () => {
  const embeddedMarkerValues = [
    ['sensitive', 'example', 'password', 'value'].join('-'),
    ['sensitive', 'fake', 'password', 'value'].join('-'),
    ['sensitive', 'demo', 'password', 'value'].join('-'),
  ];
  const content = [
    'password = "example-password"',
    'password = "fake-password"',
    'password = "demo-password"',
    ['password', JSON.stringify(embeddedMarkerValues[0])].join(' = '),
    ['password', JSON.stringify(embeddedMarkerValues[1])].join(' = '),
    ['password', JSON.stringify(embeddedMarkerValues[2])].join(' = '),
  ].join('\n');

  assert.deepEqual(scanSecretText('config.ts', content), [
    { file: 'config.ts', line: 4, reason: 'probable hard-coded credential' },
    { file: 'config.ts', line: 5, reason: 'probable hard-coded credential' },
    { file: 'config.ts', line: 6, reason: 'probable hard-coded credential' },
  ]);
});

test('detects personal email providers but allows synthetic email addresses', () => {
  const content = [
    ['owner', ['alice', 'gmail.com'].join('@')].join(' = '),
    ['owner', ['alerts', 'example.com'].join('@')].join(' = '),
    ['owner', ['service', 'corp.invalid'].join('@')].join(' = '),
    ['owner', ['service', 'localhost'].join('@')].join(' = '),
    ['owner', ['dummy-user', 'gmail.com'].join('@')].join(' = '),
    ['owner', ['ops', 'company.com'].join('@')].join(' = '),
    ['owner', ['bob', 'yahoo.com'].join('@')].join(' = '),
  ].join('\n');

  assert.deepEqual(scanSecretText('contacts.ts', content), [
    { file: 'contacts.ts', line: 1, reason: 'personal email address' },
    { file: 'contacts.ts', line: 7, reason: 'personal email address' },
  ]);
});

test('detects hard-coded credentials in Terraform configurations', () => {
  const content = [
    ['password', '"sensitive-corporate-secret-value-12345"'].join(' = '),
    ['operator_access_token', '"sensitive-operator-auth-token-12345"'].join(' = '),
  ].join('\n');

  assert.deepEqual(scanSecretText('main.tf', content), [
    { file: 'main.tf', line: 1, reason: 'probable hard-coded credential' },
    { file: 'main.tf', line: 2, reason: 'probable hard-coded credential' },
  ]);
});

test('does not let symbolic-reference fragments hide literal credentials', () => {
  const content = [
    [['pass', 'word'].join(''), ' = "corp-var.production-secret"'].join(''),
    [['pass', 'word'].join(''), ' = "corp-module.production-secret"'].join(''),
    ['postgresql://var.service', 'module.production-secret@db.internal/app'].join(':'),
  ].join('\n');

  assert.deepEqual(scanSecretText('main.tf', content), [
    { file: 'main.tf', line: 1, reason: 'probable hard-coded credential' },
    { file: 'main.tf', line: 2, reason: 'probable hard-coded credential' },
    { file: 'main.tf', line: 3, reason: 'credential-bearing URL' },
  ]);
});
