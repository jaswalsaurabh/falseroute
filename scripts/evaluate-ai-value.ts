import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ActionOrigin } from '../packages/contracts/src/incident-intelligence.ts';
import {
  parseModelReplayEvidence,
  type ModelReplayEvidence,
} from './fixtures/ai-value/model-replay.ts';

const HYBRID_REPLAY_EVIDENCE_PATH = 'scripts/fixtures/ai-value/v1/hybrid-replay-evidence.json';

function loadHybridReplayEvidence(): readonly ModelReplayEvidence[] {
  const input = JSON.parse(readFileSync(HYBRID_REPLAY_EVIDENCE_PATH, 'utf8')) as {
    records?: readonly {
      fixtureId: string;
      assessment: unknown;
      finalOptionalActions: readonly string[];
      actionOrigins: readonly string[];
    }[];
  };
  if (!Array.isArray(input.records)) throw new Error('Hybrid replay evidence records are required');
  return input.records.map((record) =>
    parseModelReplayEvidence({
      fixtureId: record.fixtureId,
      provider: 'gemini',
      replaySource: 'hybrid',
      assessmentProvenance: 'MODEL_INFERENCE',
      assessment: record.assessment,
      policyOutcome: {
        owner: 'DETERMINISTIC_POLICY',
        finalOptionalActions: record.finalOptionalActions,
        actionOrigins: record.actionOrigins,
      },
    }),
  );
}

export const METRIC_DEFINITIONS = {
  crossSignalSynthesis: 20,
  stageRiskInference: 15,
  optionalResponseSelection: 25,
  adaptationToNewEvidence: 15,
  evidenceLinkedExplanation: 15,
  operatorWorkReduction: 10,
} as const;

type Dimension = keyof typeof METRIC_DEFINITIONS;
export interface ReplayFixture {
  readonly fixtureId: string;
  readonly scenarioKind: string;
  readonly control: 'positive' | 'negative';
  readonly evidenceIds: readonly string[];
  readonly expectedStage: string;
  readonly expectedRisk: string;
  readonly applicableDimensions: readonly Dimension[];
  readonly acceptableOptionalActionSets: readonly (readonly string[])[];
  readonly fallbackOptionalActions: readonly string[];
  readonly finalOptionalActions: readonly string[];
  readonly actionOrigins: readonly ActionOrigin[];
}

export interface FixtureSet {
  readonly fixtureSetVersion: string;
  readonly fixtures: readonly ReplayFixture[];
}

export interface EvaluationResult {
  readonly fixtureSetVersion: string;
  readonly fixtureCount: number;
  readonly metrics: {
    readonly aiValueCoverage: number;
    readonly meaningfulModelInfluenceRate: number;
  };
  readonly applicableWeight: number;
  readonly passedWeight: number;
  readonly eligibleInfluenceCheckpoints: number;
  readonly influencedCheckpoints: number;
  readonly fixtures: readonly {
    readonly fixtureId: string;
    readonly passedDimensions: readonly Dimension[];
    readonly failedDimensions: readonly Dimension[];
    readonly eligibleForModelInfluence: boolean;
    readonly modelInfluenced: boolean;
    readonly modelEvidenceAvailable: boolean;
  }[];
}

const ACTION_ORIGINS = new Set<ActionOrigin>([
  'MODEL_REQUEST',
  'MANDATORY_RULE',
  'POLICY_FALLBACK',
  'DEGRADED_FALLBACK',
]);
const EXISTING_SCENARIOS = [
  'ENV_FILE_PROBE',
  'WORDPRESS_CONFIG_PROBE',
  'SUSPICIOUS_IP_BURST',
  'SIP_INVITE_FLOOD',
  'TOKEN_TAMPER',
  'PATH_TRAVERSAL_PROBE',
  'DECOY_CREDENTIAL_USE',
] as const;

function normalizedActions(actions: readonly string[]): string {
  return actions.toSorted().join('|');
}

function normalizedRecommendations(actions: readonly string[]): string {
  return normalizedActions(actions.filter((action) => action !== 'NO_ACTION'));
}

function expectedStage(stage: string): string {
  const normalized = stage.toUpperCase();
  const aliases: Record<string, string> = {
    INITIAL_PROBE: 'RECONNAISSANCE',
    ACTIVE_BURST: 'CONTAINMENT_CANDIDATE',
    ACTIVE_FLOOD: 'CONTAINMENT_CANDIDATE',
    CREDENTIAL_TAMPER: 'CREDENTIAL_ATTACK',
    CONFIRMED_INTRUSION: 'DECEPTION_ENGAGEMENT',
    BENIGN: 'INSUFFICIENT_EVIDENCE',
  };
  return aliases[normalized] ?? normalized;
}

function containsAll(values: readonly string[], expected: readonly string[]): boolean {
  const valueSet = new Set(values);
  return expected.every((value) => valueSet.has(value));
}

function validateReplayEvidence(
  evidence: readonly ModelReplayEvidence[],
): ReadonlyMap<string, ModelReplayEvidence> {
  const byFixture = new Map<string, ModelReplayEvidence>();
  for (const candidate of evidence) {
    let parsed: ModelReplayEvidence;
    try {
      parsed = parseModelReplayEvidence(candidate);
    } catch (error) {
      throw new Error(
        `Invalid model replay evidence: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (byFixture.has(parsed.fixtureId)) {
      throw new Error(`Duplicate model replay evidence: ${parsed.fixtureId}`);
    }
    byFixture.set(parsed.fixtureId, parsed);
  }
  return byFixture;
}

function validateFixtureSet(input: unknown): FixtureSet {
  if (!input || typeof input !== 'object') throw new Error('Fixture set must be an object');
  const set = input as Partial<FixtureSet>;
  if (!set.fixtureSetVersion || !Array.isArray(set.fixtures) || set.fixtures.length === 0) {
    throw new Error('Fixture set version and non-empty fixtures are required');
  }

  const seen = new Set<string>();
  for (const fixture of set.fixtures) {
    if (!fixture || typeof fixture !== 'object' || typeof fixture.fixtureId !== 'string') {
      throw new Error('Every fixture requires a fixtureId');
    }
    if (seen.has(fixture.fixtureId)) throw new Error(`Duplicate fixtureId: ${fixture.fixtureId}`);
    seen.add(fixture.fixtureId);
    if (fixture.evidenceIds.length === 0)
      throw new Error(`${fixture.fixtureId} has no evidence references`);
    if (fixture.applicableDimensions.length === 0)
      throw new Error(`${fixture.fixtureId} has no applicable metric dimensions`);
    if (fixture.actionOrigins.length !== fixture.finalOptionalActions.length) {
      throw new Error(`${fixture.fixtureId} action provenance does not match final actions`);
    }
    for (const origin of fixture.actionOrigins) {
      if (!ACTION_ORIGINS.has(origin))
        throw new Error(`${fixture.fixtureId} has invalid action provenance`);
    }
    for (const dimension of fixture.applicableDimensions) {
      if (!(dimension in METRIC_DEFINITIONS))
        throw new Error(`${fixture.fixtureId} has unknown metric dimension`);
    }
    if (fixture.actionOrigins.includes('MODEL_REQUEST')) {
      throw new Error(
        `${fixture.fixtureId} claims MODEL_REQUEST without a model assessment in the baseline`,
      );
    }
  }
  for (const scenarioKind of EXISTING_SCENARIOS) {
    for (const control of ['positive', 'negative'] as const) {
      if (
        !set.fixtures.some(
          (fixture) => fixture.scenarioKind === scenarioKind && fixture.control === control,
        )
      ) {
        throw new Error(`Missing ${control} fixture for ${scenarioKind}`);
      }
    }
  }
  const coveredDimensions = new Set(
    set.fixtures.flatMap((fixture) => fixture.applicableDimensions),
  );
  for (const dimension of Object.keys(METRIC_DEFINITIONS)) {
    if (!coveredDimensions.has(dimension as Dimension))
      throw new Error(`Missing metric dimension: ${dimension}`);
  }
  return set as FixtureSet;
}

export function evaluateFixtureSet(
  input: unknown,
  replayEvidence: readonly ModelReplayEvidence[] = loadHybridReplayEvidence(),
): EvaluationResult {
  const set = validateFixtureSet(input);
  const evidenceByFixture = validateReplayEvidence(replayEvidence);
  let applicableWeight = 0;
  let passedWeight = 0;
  let eligibleInfluenceCheckpoints = 0;
  let influencedCheckpoints = 0;

  const fixtures = set.fixtures.map((fixture) => {
    const passedDimensions: Dimension[] = [];
    const failedDimensions: Dimension[] = [];
    const modelEvidence = evidenceByFixture.get(fixture.fixtureId);
    const assessment = modelEvidence?.assessment;
    const assessmentMatchesEvidence =
      assessment !== undefined && containsAll(assessment.evidenceRefs, fixture.evidenceIds);
    const assessmentMatchesExpected =
      assessment !== undefined &&
      assessment.incidentStage === expectedStage(fixture.expectedStage) &&
      assessment.riskTier === fixture.expectedRisk.toUpperCase();
    const optionalSelectionIsValid =
      assessment !== undefined &&
      fixture.acceptableOptionalActionSets.some(
        (actions) =>
          normalizedRecommendations(actions) ===
          normalizedRecommendations(assessment.recommendedActions),
      );
    const policyOutcomeIsBounded =
      modelEvidence !== undefined &&
      modelEvidence.policyOutcome.owner === 'DETERMINISTIC_POLICY' &&
      fixture.acceptableOptionalActionSets.some(
        (actions) =>
          normalizedActions(actions) ===
          normalizedActions(modelEvidence.policyOutcome.finalOptionalActions),
      );
    for (const dimension of fixture.applicableDimensions) {
      const weight = METRIC_DEFINITIONS[dimension];
      applicableWeight += weight;
      const passed =
        modelEvidence !== undefined &&
        modelEvidence.assessmentProvenance === 'MODEL_INFERENCE' &&
        policyOutcomeIsBounded &&
        (dimension === 'crossSignalSynthesis'
          ? assessmentMatchesEvidence
          : dimension === 'stageRiskInference'
            ? assessmentMatchesExpected
            : dimension === 'optionalResponseSelection'
              ? optionalSelectionIsValid
              : dimension === 'adaptationToNewEvidence'
                ? assessmentMatchesEvidence && assessment?.needsFollowUp === true
                : dimension === 'evidenceLinkedExplanation'
                  ? assessmentMatchesEvidence &&
                    assessment?.hypothesis.length !== 0 &&
                    assessment?.rationale.length !== 0
                  : optionalSelectionIsValid || assessmentMatchesExpected);
      if (passed) {
        passedDimensions.push(dimension);
        passedWeight += weight;
      } else failedDimensions.push(dimension);
    }

    const hasGenuineChoice = fixture.acceptableOptionalActionSets.length >= 2;
    const modelInfluenced =
      hasGenuineChoice &&
      modelEvidence !== undefined &&
      modelEvidence.assessmentProvenance === 'MODEL_INFERENCE' &&
      optionalSelectionIsValid &&
      normalizedActions(modelEvidence.assessment.recommendedActions) !==
        normalizedActions(fixture.fallbackOptionalActions) &&
      normalizedActions(modelEvidence.policyOutcome.finalOptionalActions) !==
        normalizedActions(fixture.fallbackOptionalActions) &&
      modelEvidence.policyOutcome.actionOrigins.includes('MODEL_REQUEST') &&
      policyOutcomeIsBounded;
    if (hasGenuineChoice) {
      eligibleInfluenceCheckpoints++;
      if (modelInfluenced) influencedCheckpoints++;
    }
    return {
      fixtureId: fixture.fixtureId,
      passedDimensions,
      failedDimensions,
      eligibleForModelInfluence: hasGenuineChoice,
      modelInfluenced,
      modelEvidenceAvailable: modelEvidence !== undefined,
    };
  });

  return {
    fixtureSetVersion: set.fixtureSetVersion,
    fixtureCount: set.fixtures.length,
    metrics: {
      aiValueCoverage: applicableWeight === 0 ? 0 : (passedWeight / applicableWeight) * 100,
      meaningfulModelInfluenceRate:
        eligibleInfluenceCheckpoints === 0
          ? 0
          : (influencedCheckpoints / eligibleInfluenceCheckpoints) * 100,
    },
    applicableWeight,
    passedWeight,
    eligibleInfluenceCheckpoints,
    influencedCheckpoints,
    fixtures,
  };
}

function main(): void {
  const fixturePath = resolve(
    process.argv[2] ?? 'scripts/fixtures/ai-value/v1/replay-fixtures.json',
  );
  const outputPath = resolve(process.argv[3] ?? '.ai-value-results/ai-value-v1.json');
  const result = evaluateFixtureSet(JSON.parse(readFileSync(fixturePath, 'utf8')));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`AI Value Coverage: ${result.metrics.aiValueCoverage.toFixed(2)}%`);
  console.log(
    `Meaningful Model Influence Rate: ${result.metrics.meaningfulModelInfluenceRate.toFixed(2)}%`,
  );
  console.log(
    `Fixtures: ${result.fixtureCount}; eligible influence checkpoints: ${result.eligibleInfluenceCheckpoints}`,
  );
}

if (process.argv[1]?.endsWith('evaluate-ai-value.ts')) main();
