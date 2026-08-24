import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  captureHybridEvidence,
  replayHybridEvidence,
  type CaptureInput,
  type ReplayFixtureDefinition,
} from './hybrid-replay.ts';

const fixtureSet = JSON.parse(
  readFileSync('scripts/fixtures/ai-value/v1/replay-fixtures.json', 'utf8'),
) as { fixtures: ReplayFixtureDefinition[] };
const replayEvidence = JSON.parse(
  readFileSync('scripts/fixtures/ai-value/v1/hybrid-replay-evidence.json', 'utf8'),
);

test('sanitized hybrid replay contains every existing fixture and reports model influence', () => {
  const report = replayHybridEvidence(replayEvidence, fixtureSet.fixtures);

  assert.equal(report.fixtureCount, 14);
  assert.equal(report.assessmentCount, 14);
  assert.equal(report.modelInfluenceEligibleCount, 6);
  assert.equal(report.modelInfluenceCount, 6);
  assert.equal(report.policyOutcomeCount, 12);
});

test('capture strips network and credential-shaped text while retaining bounded evidence', () => {
  const source = replayEvidence.records[0];
  const input: CaptureInput = {
    fixtureSetVersion: 'ai-value-v1',
    records: replayEvidence.records.map((record: typeof source) =>
      Object.assign({}, record, {
        ...record,
        assessment: {
          ...record.assessment,
          rationale: 'Observed at https://internal.example/198.51.100.10 token=secret-value.',
        },
      }),
    ),
  };

  const captured = captureHybridEvidence(input, fixtureSet.fixtures);
  const rationale = captured.records[0]?.assessment.rationale ?? '';
  assert.equal(rationale.includes('[REDACTED_URL]'), true);
  assert.equal(rationale.includes('secret-value'), false);
  assert.equal(rationale.includes('198.51.100.10'), false);
});

test('capture rejects an incomplete or cross-fixture evidence set', () => {
  const incomplete: CaptureInput = {
    records: replayEvidence.records.slice(0, 13),
  };
  assert.throws(
    () => captureHybridEvidence(incomplete, fixtureSet.fixtures),
    /Expected one capture record for each of 14 fixtures/,
  );

  const crossFixture: CaptureInput = {
    records: replayEvidence.records.map((record: (typeof replayEvidence.records)[number]) =>
      record.fixtureId === 'env-positive'
        ? Object.assign({}, record, { evidenceIds: ['credential-signal'] })
        : record,
    ),
  };
  assert.throws(
    () => captureHybridEvidence(crossFixture, fixtureSet.fixtures),
    /outside its fixture evidence set/,
  );
});

test('capture accepts NO_ACTION for negative-control model recommendations', () => {
  const input: CaptureInput = {
    records: replayEvidence.records.map((record: (typeof replayEvidence.records)[number]) =>
      record.fixtureId === 'env-negative'
        ? Object.assign({}, record, {
            assessment: { ...record.assessment, recommendedActions: ['NO_ACTION'] },
          })
        : record,
    ),
  };

  const captured = captureHybridEvidence(input, fixtureSet.fixtures);
  assert.deepEqual(
    captured.records.find((record) => record.fixtureId === 'env-negative')?.assessment
      .recommendedActions,
    ['NO_ACTION'],
  );
});

test('capture rejects NO_ACTION combined with an executable recommendation', () => {
  const input: CaptureInput = {
    records: replayEvidence.records.map((record: (typeof replayEvidence.records)[number]) =>
      record.fixtureId === 'env-negative'
        ? Object.assign({}, record, {
            assessment: {
              ...record.assessment,
              recommendedActions: ['NO_ACTION', 'ALERT_OPERATOR'],
            },
          })
        : record,
    ),
  };

  assert.throws(
    () => captureHybridEvidence(input, fixtureSet.fixtures),
    /recommendedActions is invalid/,
  );
});
