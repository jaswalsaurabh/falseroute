import assert from 'node:assert/strict';
import test from 'node:test';
import { scanPublicConfigText } from './public-config-check.ts';

test('rejects hard-coded Terraform backend state configuration', () => {
  assert.deepEqual(
    scanPublicConfigText(
      'infrastructure/terraform/backend.tf',
      [
        'terraform {',
        '  backend "gcs" {',
        '    bucket = "private-project-tfstate"',
        '  }',
        '}',
      ].join('\n'),
    ),
    [
      {
        file: 'infrastructure/terraform/backend.tf',
        line: 3,
        reason: 'Terraform state bucket must be supplied through private backend configuration',
      },
    ],
  );
});

test('rejects environment-specific defaults but allows public examples', () => {
  const privateFindings = scanPublicConfigText(
    'infrastructure/terraform/variables.tf',
    [
      'variable "project_id" {',
      '  default = "real-project-123"',
      '}',
      'variable "incident_contact_email" {',
      '  default = "owner@private.org"',
      '}',
    ].join('\n'),
  );
  assert.equal(privateFindings.length, 2);
  assert.equal(
    scanPublicConfigText(
      'infrastructure/terraform/variables.tf',
      [
        'variable "project_id" {',
        '  default = "falseroute-staging-example"',
        '}',
        'variable "incident_contact_email" {',
        '  default = "alerts@example.com"',
        '}',
      ].join('\n'),
    ).length,
    0,
  );
});

test('does not inspect application code or unrelated Terraform defaults', () => {
  assert.deepEqual(
    scanPublicConfigText('packages/example/src/config.ts', 'project_id = "private-project"'),
    [],
  );
  assert.deepEqual(
    scanPublicConfigText(
      'infrastructure/terraform/variables.tf',
      'variable "api_image_tag" { default = "sha256:abc" }',
    ),
    [],
  );
});
