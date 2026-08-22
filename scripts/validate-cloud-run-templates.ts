import fs from 'node:fs';
import path from 'node:path';

export interface TemplateValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
}

const LOCAL_PATH_REGEX = /(?:\/Users\/|[a-zA-Z]:\\|\/home\/)/i;
const SENSITIVE_KEYS = new Set(['DATABASE_URL', 'OPERATOR_ACCESS_TOKEN', 'GEMINI_API_KEY']);

export function validateCloudRunTemplate(
  filePath: string,
  content: string,
): TemplateValidationResult {
  const errors: string[] = [];

  // Check 1: No local filesystem paths
  if (LOCAL_PATH_REGEX.test(content)) {
    errors.push('Template contains local filesystem path reference.');
  }

  // Check 2: API and Worker must enforce single instance safety
  const isApi = filePath.includes('api.service.yaml');
  const isWorker = filePath.includes('worker.service.yaml');

  if (isApi || isWorker) {
    if (
      !content.includes("autoscaling.knative.dev/maxScale: '1'") &&
      !content.includes('autoscaling.knative.dev/maxScale: "1"')
    ) {
      errors.push(
        'API and Worker must enforce autoscaling.knative.dev/maxScale: "1" while controls remain process-local.',
      );
    }
  }

  // Check 3: Worker must have always-on CPU allocation and minScale 1
  if (isWorker) {
    if (
      !content.includes("run.googleapis.com/cpu-throttling: 'false'") &&
      !content.includes('run.googleapis.com/cpu-throttling: "false"')
    ) {
      errors.push(
        'Worker service must specify run.googleapis.com/cpu-throttling: "false" for continuous background polling.',
      );
    }
    if (
      !content.includes("autoscaling.knative.dev/minScale: '1'") &&
      !content.includes('autoscaling.knative.dev/minScale: "1"')
    ) {
      errors.push(
        'Worker service must specify autoscaling.knative.dev/minScale: "1" to ensure an active instance is running.',
      );
    }
  }

  // Check 4: Sensitive variables must use secretKeyRef and not plain text value
  const envBlocks = content.split(/\n\s*-\s*name:\s*/);
  for (const block of envBlocks) {
    for (const sensitiveKey of SENSITIVE_KEYS) {
      if (
        block.startsWith(sensitiveKey) ||
        block.startsWith(`"${sensitiveKey}"`) ||
        block.startsWith(`'${sensitiveKey}'`)
      ) {
        if (!block.includes('secretKeyRef:')) {
          errors.push(`Sensitive variable ${sensitiveKey} must use secretKeyRef, not plain value.`);
        }
      }
    }
  }

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
  };
}

export function validateAllTemplates(dirPath: string): TemplateValidationResult[] {
  const results: TemplateValidationResult[] = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      const fullPath = path.join(dirPath, entry.name);
      const content = fs.readFileSync(fullPath, 'utf8');
      results.push(validateCloudRunTemplate(entry.name, content));
    }
  }

  return results;
}

export function runTemplateValidation(
  templatesDir = path.resolve(process.cwd(), 'infrastructure/cloud-run'),
): boolean {
  console.log('--- Validating Cloud Run Deployment Templates ---');
  const results = validateAllTemplates(templatesDir);

  let hasErrors = false;
  for (const result of results) {
    if (result.valid) {
      console.log(`✅ [cloud-run-validator] ${result.file}: Valid`);
    } else {
      console.error(`❌ [cloud-run-validator] ${result.file} failed validation:`);
      for (const err of result.errors) {
        console.error(`   - ${err}`);
      }
      hasErrors = true;
    }
  }

  if (!hasErrors && results.length > 0) {
    console.log(`✅ All ${results.length} Cloud Run templates passed validation.`);
  }

  return !hasErrors;
}

if (process.argv[1]?.endsWith('validate-cloud-run-templates.ts')) {
  const success = runTemplateValidation();
  process.exit(success ? 0 : 1);
}
