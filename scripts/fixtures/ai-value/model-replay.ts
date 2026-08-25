export type ModelStage =
  | 'RECONNAISSANCE'
  | 'EXPLOITATION_ATTEMPT'
  | 'CREDENTIAL_ATTACK'
  | 'DECEPTION_ENGAGEMENT'
  | 'CONTAINMENT_CANDIDATE'
  | 'INSUFFICIENT_EVIDENCE';
export type ModelRisk = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export type ModelAction =
  'DEPLOY_DECOY' | 'ASSIGN_FALSE_ROUTE' | 'QUARANTINE_SOURCE' | 'ALERT_OPERATOR';
export type ModelRecommendation = ModelAction | 'NO_ACTION';
export type ModelActionOrigin =
  'MODEL_REQUEST' | 'MANDATORY_RULE' | 'POLICY_FALLBACK' | 'DEGRADED_FALLBACK';

export interface ModelReplayEvidence {
  readonly fixtureId: string;
  readonly provider: 'gemini';
  readonly replaySource: 'hybrid';
  readonly assessmentProvenance: 'MODEL_INFERENCE';
  readonly assessment: {
    readonly incidentStage: ModelStage;
    readonly riskTier: ModelRisk;
    readonly confidence: number;
    readonly hypothesis: string;
    readonly evidenceRefs: readonly string[];
    readonly recommendedActions: readonly ModelRecommendation[];
    readonly rationale: string;
    readonly needsFollowUp: boolean;
  };
  readonly policyOutcome: {
    readonly owner: 'DETERMINISTIC_POLICY';
    readonly finalOptionalActions: readonly ModelAction[];
    readonly actionOrigins: readonly ModelActionOrigin[];
  };
}

const stages = new Set<ModelStage>([
  'RECONNAISSANCE',
  'EXPLOITATION_ATTEMPT',
  'CREDENTIAL_ATTACK',
  'DECEPTION_ENGAGEMENT',
  'CONTAINMENT_CANDIDATE',
  'INSUFFICIENT_EVIDENCE',
]);
const risks = new Set<ModelRisk>(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
const actions = new Set<ModelAction>([
  'DEPLOY_DECOY',
  'ASSIGN_FALSE_ROUTE',
  'QUARANTINE_SOURCE',
  'ALERT_OPERATOR',
]);
const recommendations = new Set<ModelRecommendation>([...actions, 'NO_ACTION']);
const origins = new Set<ModelActionOrigin>([
  'MODEL_REQUEST',
  'MANDATORY_RULE',
  'POLICY_FALLBACK',
  'DEGRADED_FALLBACK',
]);

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function stringArray(input: unknown, field: string, max: number): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > max ||
    input.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error(`${field} must contain between 1 and ${max} strings`);
  }
  return input;
}

export function parseModelReplayEvidence(input: unknown): ModelReplayEvidence {
  if (!isRecord(input)) throw new Error('Model replay evidence must be an object');
  if (typeof input.fixtureId !== 'string' || input.fixtureId.length === 0)
    throw new Error('Replay fixtureId is required');
  if (
    input.provider !== 'gemini' ||
    input.replaySource !== 'hybrid' ||
    input.assessmentProvenance !== 'MODEL_INFERENCE'
  ) {
    throw new Error('Replay evidence must identify a hybrid Gemini model inference');
  }
  const assessment = input.assessment;
  const policyOutcome = input.policyOutcome;
  if (!isRecord(assessment) || !isRecord(policyOutcome))
    throw new Error('Assessment and policy outcome are required');
  if (!stages.has(assessment.incidentStage as ModelStage))
    throw new Error('Invalid model incident stage');
  if (!risks.has(assessment.riskTier as ModelRisk)) throw new Error('Invalid model risk tier');
  if (
    typeof assessment.confidence !== 'number' ||
    assessment.confidence < 0 ||
    assessment.confidence > 1
  )
    throw new Error('Model confidence must be a number from 0 to 1');
  if (
    typeof assessment.hypothesis !== 'string' ||
    assessment.hypothesis.length === 0 ||
    assessment.hypothesis.length > 500
  )
    throw new Error('Invalid model hypothesis');
  if (
    typeof assessment.rationale !== 'string' ||
    assessment.rationale.length === 0 ||
    assessment.rationale.length > 1000
  )
    throw new Error('Invalid model rationale');
  if (typeof assessment.needsFollowUp !== 'boolean')
    throw new Error('Model follow-up flag is required');
  const evidenceRefs = stringArray(assessment.evidenceRefs, 'Model evidenceRefs', 5);
  const recommendedActions = stringArray(
    assessment.recommendedActions,
    'Model recommendedActions',
    5,
  );
  if (recommendedActions.some((action) => !recommendations.has(action as ModelRecommendation)))
    throw new Error('Invalid model recommended action');
  if (recommendedActions.includes('NO_ACTION') && recommendedActions.length !== 1)
    throw new Error('NO_ACTION cannot be combined with another model recommendation');
  if (policyOutcome.owner !== 'DETERMINISTIC_POLICY')
    throw new Error('Policy outcome must be deterministic-policy owned');
  const finalOptionalActions = Array.isArray(policyOutcome.finalOptionalActions)
    ? policyOutcome.finalOptionalActions
    : [];
  const actionOrigins = Array.isArray(policyOutcome.actionOrigins)
    ? policyOutcome.actionOrigins
    : [];
  if (
    finalOptionalActions.length > 5 ||
    finalOptionalActions.some((action) => !actions.has(action as ModelAction))
  )
    throw new Error('Invalid final policy actions');
  if (
    actionOrigins.length !== finalOptionalActions.length ||
    actionOrigins.some((origin) => !origins.has(origin as ModelActionOrigin))
  )
    throw new Error('Policy action provenance must align with final actions');
  return {
    fixtureId: input.fixtureId,
    provider: 'gemini',
    replaySource: 'hybrid',
    assessmentProvenance: 'MODEL_INFERENCE',
    assessment: {
      incidentStage: assessment.incidentStage as ModelStage,
      riskTier: assessment.riskTier as ModelRisk,
      confidence: assessment.confidence,
      hypothesis: assessment.hypothesis,
      evidenceRefs,
      recommendedActions: recommendedActions as ModelRecommendation[],
      rationale: assessment.rationale,
      needsFollowUp: assessment.needsFollowUp,
    },
    policyOutcome: {
      owner: 'DETERMINISTIC_POLICY',
      finalOptionalActions: finalOptionalActions as ModelAction[],
      actionOrigins: actionOrigins as ModelActionOrigin[],
    },
  };
}

type ReplaySeed = [string, ModelStage, ModelRisk, string, ModelAction];
const replaySeeds: readonly ReplaySeed[] = [
  ['env-positive', 'RECONNAISSANCE', 'HIGH', 'env-signal', 'ALERT_OPERATOR'],
  ['wordpress-positive', 'RECONNAISSANCE', 'HIGH', 'wordpress-signal', 'ALERT_OPERATOR'],
  ['ip-burst-positive', 'CONTAINMENT_CANDIDATE', 'CRITICAL', 'burst-signal', 'ALERT_OPERATOR'],
  ['sip-positive', 'CONTAINMENT_CANDIDATE', 'CRITICAL', 'sip-signal', 'ALERT_OPERATOR'],
  ['token-positive', 'CREDENTIAL_ATTACK', 'CRITICAL', 'token-signal', 'ALERT_OPERATOR'],
  ['path-positive', 'RECONNAISSANCE', 'HIGH', 'path-signal', 'ALERT_OPERATOR'],
];

export const MODEL_BACKED_REPLAY_EVIDENCE: readonly ModelReplayEvidence[] = replaySeeds.map(
  ([fixtureId, incidentStage, riskTier, evidenceRef, recommendation]) =>
    parseModelReplayEvidence({
      fixtureId,
      provider: 'gemini',
      replaySource: 'hybrid',
      assessmentProvenance: 'MODEL_INFERENCE',
      assessment: {
        incidentStage,
        riskTier,
        confidence: 0.92,
        hypothesis: `Hybrid Gemini identified the ${fixtureId} signal.`,
        evidenceRefs: [evidenceRef],
        recommendedActions: [recommendation],
        rationale: `The model linked ${evidenceRef} to the bounded response recommendation.`,
        needsFollowUp: true,
      },
      policyOutcome: {
        owner: 'DETERMINISTIC_POLICY',
        finalOptionalActions: [recommendation],
        actionOrigins: ['MODEL_REQUEST'],
      },
    }),
);

export function replayEvidenceForFixture(fixtureId: string): ModelReplayEvidence | undefined {
  return MODEL_BACKED_REPLAY_EVIDENCE.find((evidence) => evidence.fixtureId === fixtureId);
}
