import { resolve } from 'node:path';
import {
  captureHybridEvidence,
  readCaptureInput,
  readFixtureDefinitions,
  writeJson,
} from './hybrid-replay.ts';

const fixturePath = resolve(process.argv[3] ?? 'scripts/fixtures/ai-value/v1/replay-fixtures.json');
const inputPath = process.argv[2];
const outputPath = resolve(
  process.argv[4] ?? 'scripts/fixtures/ai-value/v1/hybrid-replay-evidence.json',
);

if (!inputPath) {
  console.error(
    'Usage: node scripts/ai-value/capture-hybrid-replay.ts <capture.json> [fixtures.json] [output.json]',
  );
  process.exit(2);
}

const evidence = captureHybridEvidence(
  readCaptureInput(resolve(inputPath)),
  readFixtureDefinitions(fixturePath),
);
writeJson(outputPath, evidence);
console.log(`Captured ${evidence.records.length} sanitized hybrid replay records to ${outputPath}`);
