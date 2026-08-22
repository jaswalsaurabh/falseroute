import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCloudRunTemplate, validateAllTemplates } from './validate-cloud-run-templates.ts';
import path from 'node:path';

describe('Cloud Run Template Validation', () => {
  it('validates actual repository Cloud Run templates', () => {
    const templatesDir = path.resolve(process.cwd(), 'infrastructure/cloud-run');
    const results = validateAllTemplates(templatesDir);

    assert.ok(results.length >= 3, 'Expected at least 3 templates');
    for (const result of results) {
      assert.equal(
        result.valid,
        true,
        `Template ${result.file} had errors: ${result.errors.join(', ')}`,
      );
    }
  });

  it('rejects templates containing plain-text sensitive values instead of secretKeyRef', () => {
    const invalidYaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: falseroute-api
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '1'
    spec:
      containers:
        - env:
            - name: DATABASE_URL
              value: "postgresql://falseroute:not-a-real-test-password@127.0.0.1:5432/falseroute_dev"
`;

    const result = validateCloudRunTemplate('api.service.yaml', invalidYaml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('DATABASE_URL must use secretKeyRef')));
  });

  it('rejects API templates lacking single instance maxScale constraint', () => {
    const invalidYaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: falseroute-api
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '10'
`;

    const result = validateCloudRunTemplate('api.service.yaml', invalidYaml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('autoscaling.knative.dev/maxScale: "1"')));
  });

  it('rejects worker templates without continuous background CPU allocation', () => {
    const invalidYaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: falseroute-worker
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: '1'
        autoscaling.knative.dev/maxScale: '1'
        run.googleapis.com/cpu-throttling: 'true'
`;

    const result = validateCloudRunTemplate('worker.service.yaml', invalidYaml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('run.googleapis.com/cpu-throttling: "false"')));
  });

  it('rejects templates containing local filesystem paths', () => {
    const invalidYaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: falseroute-api
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '1'
    spec:
      containers:
        - image: /Users/localuser/images/falseroute-api:latest
`;

    const result = validateCloudRunTemplate('api.service.yaml', invalidYaml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('local filesystem path')));
  });
});
