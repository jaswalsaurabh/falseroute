import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFixtureSet } from './evaluate-ai-value.ts';
import { MODEL_BACKED_REPLAY_EVIDENCE } from './fixtures/ai-value/model-replay.ts';

const fixtureSet = JSON.parse(
  readFileSync('scripts/fixtures/ai-value/v1/replay-fixtures.json', 'utf8'),
);

test('hybrid replay evaluates model-backed positive scenarios and controls', () => {
  const result = evaluateFixtureSet(fixtureSet);

  assert.equal(result.fixtureSetVersion, 'ai-value-v1');
  assert.equal(result.fixtureCount, 14);
  assert.ok(result.metrics.aiValueCoverage >= 55);
  assert.equal(result.metrics.meaningfulModelInfluenceRate, 100);
  assert.equal(result.eligibleInfluenceCheckpoints, 6);
  assert.equal(result.influencedCheckpoints, 6);
  assert.equal(
    result.fixtures.find((fixture) => fixture.fixtureId === 'env-positive')?.modelEvidenceAvailable,
    true,
  );
  assert.equal(
    result.fixtures.find((fixture) => fixture.fixtureId === 'env-negative')?.modelEvidenceAvailable,
    true,
  );
});

test('deterministic fallback provenance cannot be counted as model influence', () => {
  const replay = structuredClone(MODEL_BACKED_REPLAY_EVIDENCE);
  (replay[0]!.policyOutcome as unknown as { actionOrigins: string[] }).actionOrigins = [
    'POLICY_FALLBACK',
  ];

  const result = evaluateFixtureSet(fixtureSet, replay);
  assert.equal(result.fixtures[0]!.modelInfluenced, false);
  assert.equal(result.influencedCheckpoints, 5);
  assert.equal(result.metrics.meaningfulModelInfluenceRate, 83.33333333333334);
});

test('malformed replay provenance is rejected before scoring', () => {
  const changed = structuredClone(MODEL_BACKED_REPLAY_EVIDENCE);
  (changed[0]!.policyOutcome as unknown as { owner: string }).owner = 'MODEL';

  assert.throws(
    () => evaluateFixtureSet(fixtureSet, changed),
    /Policy outcome must be deterministic-policy owned/,
  );
});

test('baseline rejects model provenance without a model assessment', () => {
  const changed = structuredClone(fixtureSet);
  changed.fixtures[0].actionOrigins = ['MODEL_REQUEST', 'POLICY_FALLBACK'];

  assert.throws(() => evaluateFixtureSet(changed), /MODEL_REQUEST/);
});

test('baseline rejects missing evidence references and duplicate fixtures', () => {
  const missingEvidence = structuredClone(fixtureSet);
  missingEvidence.fixtures[0].evidenceIds = [];
  assert.throws(() => evaluateFixtureSet(missingEvidence), /no evidence references/);

  const duplicate = structuredClone(fixtureSet);
  duplicate.fixtures[1].fixtureId = duplicate.fixtures[0].fixtureId;
  assert.throws(() => evaluateFixtureSet(duplicate), /Duplicate fixtureId/);
});

test('baseline rejects a missing existing scenario control pair', () => {
  const changed = structuredClone(fixtureSet);
  changed.fixtures = changed.fixtures.filter(
    (fixture: { fixtureId: string }) => fixture.fixtureId !== 'sip-negative',
  );

  assert.throws(() => evaluateFixtureSet(changed), /Missing negative fixture for SIP_INVITE_FLOOD/);
});
