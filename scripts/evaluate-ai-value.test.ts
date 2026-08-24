import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFixtureSet } from './evaluate-ai-value.ts';

const fixtureSet = JSON.parse(
  readFileSync('scripts/fixtures/ai-value/v1/replay-fixtures.json', 'utf8'),
);

test('baseline evaluates every existing positive and negative scenario', () => {
  const result = evaluateFixtureSet(fixtureSet);

  assert.equal(result.fixtureSetVersion, 'ai-value-v1');
  assert.equal(result.fixtureCount, 14);
  assert.equal(result.metrics.aiValueCoverage, 0);
  assert.equal(result.metrics.meaningfulModelInfluenceRate, 0);
  assert.equal(result.eligibleInfluenceCheckpoints, 6);
  assert.equal(result.influencedCheckpoints, 0);
});

test('deterministic fallback provenance cannot be counted as model influence', () => {
  const changed = structuredClone(fixtureSet);
  changed.fixtures[0].finalOptionalActions = ['ALERT_OPERATOR'];
  changed.fixtures[0].actionOrigins = ['POLICY_FALLBACK'];

  const result = evaluateFixtureSet(changed);
  assert.equal(result.influencedCheckpoints, 0);
  assert.equal(result.metrics.meaningfulModelInfluenceRate, 0);
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
