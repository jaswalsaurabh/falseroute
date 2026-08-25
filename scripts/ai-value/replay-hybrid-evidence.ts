import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFixtureDefinitions, replayHybridEvidence, writeJson } from './hybrid-replay.ts';

const evidencePath = resolve(
  process.argv[2] ?? 'scripts/fixtures/ai-value/v1/hybrid-replay-evidence.json',
);
const fixturePath = resolve(process.argv[3] ?? 'scripts/fixtures/ai-value/v1/replay-fixtures.json');
const outputPath = process.argv[4] ? resolve(process.argv[4]) : undefined;

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const report = replayHybridEvidence(evidence, readFixtureDefinitions(fixturePath));
if (outputPath) writeJson(outputPath, report);
console.log(
  `Replayed ${report.fixtureCount} records; ${report.modelInfluenceCount}/${report.modelInfluenceEligibleCount} meaningful model-influence checkpoints`,
);
