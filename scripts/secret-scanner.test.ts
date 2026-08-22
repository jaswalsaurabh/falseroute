import assert from 'node:assert/strict';
import test from 'node:test';
import { isForbiddenSecretFile, scanSecretText } from './secret-scanner.ts';

test('rejects private environment and key files while allowing examples', () => {
  assert.equal(isForbiddenSecretFile('.env.production'), true);
  assert.equal(isForbiddenSecretFile('config/.env.example'), false);
  assert.equal(isForbiddenSecretFile('certificates/service.key'), true);
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

test('allows explicit placeholders and local test connection strings', () => {
  const content = [
    'password = "not-a-real-password"',
    'apiKey = process.env.GEMINI_API_KEY',
    ['postgresql://test-user', 'dummy-password@127.0.0.1/app_test'].join(':'),
  ].join('\n');

  assert.deepEqual(scanSecretText('config.test.ts', content), []);
});
