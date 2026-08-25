import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const HYBRID_REPLAY_VERSION = '1.0.0' as const;
const ACTIONS = new Set([
  'DEPLOY_DECOY',
  'ASSIGN_FALSE_ROUTE',
  'QUARANTINE_SOURCE',
  'ALERT_OPERATOR',
]);
const MODEL_RECOMMENDATIONS = new Set([...ACTIONS, 'NO_ACTION']);
const ORIGINS = new Set([
  'MODEL_REQUEST',
  'MANDATORY_RULE',
  'POLICY_FALLBACK',
  'DEGRADED_FALLBACK',
]);
const STAGES = new Set([
  'RECONNAISSANCE',
  'EXPLOITATION_ATTEMPT',
  'CREDENTIAL_ATTACK',
  'DECEPTION_ENGAGEMENT',
  'CONTAINMENT_CANDIDATE',
  'INSUFFICIENT_EVIDENCE',
]);
const RISKS = new Set(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
const POLICY_REASONS = new Set([
  'MODEL_REQUEST_ACCEPTED',
  'MODEL_REQUEST_NARROWED',
  'MODEL_REQUEST_REJECTED',
  'MANDATORY_RULE_APPLIED',
  'POLICY_FALLBACK_APPLIED',
  'DEGRADED_FALLBACK_APPLIED',
]);
const TOOL_ACTIONS: Record<string, string> = {
  request_decoy_deployment: 'DEPLOY_DECOY',
  request_false_route_assignment: 'ASSIGN_FALSE_ROUTE',
  request_source_quarantine: 'QUARANTINE_SOURCE',
  request_operator_alert: 'ALERT_OPERATOR',
};

export interface ReplayFixtureDefinition {
  readonly fixtureId: string;
  readonly evidenceIds: readonly string[];
  readonly fallbackOptionalActions: readonly string[];
}
export interface CaptureRecordInput {
  readonly fixtureId: string;
  readonly evidenceIds: readonly string[];
  readonly assessment: unknown;
  readonly policyOutcomes?: readonly {
    readonly action?: unknown;
    readonly toolName?: unknown;
    readonly outcome: unknown;
    readonly origin?: unknown;
    readonly reasonCode?: unknown;
  }[];
  readonly fallbackOptionalActions: readonly unknown[];
  readonly finalOptionalActions: readonly unknown[];
  readonly actionOrigins: readonly unknown[];
}
export interface CaptureInput {
  readonly fixtureSetVersion?: string;
  readonly records: readonly CaptureRecordInput[];
}
export interface ReplayReport {
  readonly replaySchemaVersion: typeof HYBRID_REPLAY_VERSION;
  readonly fixtureSetVersion: string;
  readonly fixtureCount: number;
  readonly assessmentCount: number;
  readonly policyOutcomeCount: number;
  readonly modelInfluenceEligibleCount: number;
  readonly modelInfluenceCount: number;
  readonly records: readonly {
    readonly fixtureId: string;
    readonly assessmentValid: true;
    readonly evidenceRefs: readonly string[];
    readonly policyOutcomes: readonly string[];
    readonly modelInfluenced: boolean;
  }[];
}
export interface HybridReplayRecord {
  readonly fixtureId: string;
  readonly evidenceIds: readonly string[];
  readonly assessment: Assessment;
  readonly policyOutcomes: readonly PolicyOutcome[];
  readonly fallbackOptionalActions: readonly string[];
  readonly finalOptionalActions: readonly string[];
  readonly actionOrigins: readonly string[];
}
export interface HybridReplayEvidence {
  readonly replaySchemaVersion: typeof HYBRID_REPLAY_VERSION;
  readonly fixtureSetVersion: string;
  readonly source: 'hybrid-synthetic';
  readonly records: readonly HybridReplayRecord[];
}
interface Assessment {
  readonly incidentStage: string;
  readonly riskTier: string;
  readonly confidence: number;
  readonly hypothesis: string;
  readonly evidenceRefs: readonly string[];
  readonly recommendedActions: readonly string[];
  readonly rationale: string;
  readonly needsFollowUp: boolean;
}
interface PolicyOutcome {
  readonly action: string;
  readonly outcome: 'AUTHORIZED' | 'NARROWED' | 'REJECTED';
  readonly origin: string;
  readonly reasonCode: string;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const cleaned = value
    // Control characters are removed before replay artifacts are persisted.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .trim();
  if (!cleaned || cleaned.length > max) throw new Error(`${field} is invalid`);
  return cleaned;
}
function stringArray(
  value: unknown,
  field: string,
  max: number,
  maxLength: number,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    (!allowEmpty && value.length < 1) ||
    value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > maxLength)
  )
    throw new Error(`${field} is invalid`);
  return value as string[];
}
function actionArray(value: unknown, field: string, allowEmpty = false): string[] {
  const actions = stringArray(value, field, 5, 64, allowEmpty);
  if (actions.some((action) => !ACTIONS.has(action))) throw new Error(`${field} is invalid`);
  return actions;
}
function recommendationArray(value: unknown, field: string): string[] {
  const recommendations = stringArray(value, field, 5, 64);
  if (
    recommendations.some((action) => !MODEL_RECOMMENDATIONS.has(action)) ||
    (recommendations.includes('NO_ACTION') && recommendations.length !== 1)
  )
    throw new Error(`${field} is invalid`);
  return recommendations;
}
function originArray(value: unknown): string[] {
  const origins = stringArray(value, 'actionOrigins', 5, 32, true);
  if (origins.some((origin) => !ORIGINS.has(origin))) throw new Error('actionOrigins is invalid');
  return origins;
}
function policyOutcome(input: unknown): PolicyOutcome {
  if (!input || typeof input !== 'object') throw new Error('Replay policy outcome is invalid');
  const value = input as Record<string, unknown>;
  const rawAction = typeof value['action'] === 'string' ? value['action'] : value['toolName'];
  const action =
    typeof rawAction === 'string' && TOOL_ACTIONS[rawAction] ? TOOL_ACTIONS[rawAction] : rawAction;
  if (
    typeof action !== 'string' ||
    !ACTIONS.has(action) ||
    !['AUTHORIZED', 'NARROWED', 'REJECTED'].includes(value['outcome'] as string) ||
    typeof value['origin'] !== 'string' ||
    !ORIGINS.has(value['origin']) ||
    typeof value['reasonCode'] !== 'string' ||
    !POLICY_REASONS.has(value['reasonCode'])
  )
    throw new Error('Replay policy outcome is invalid');
  return {
    action,
    outcome: value['outcome'] as PolicyOutcome['outcome'],
    origin: value['origin'],
    reasonCode: value['reasonCode'],
  };
}
function record(input: unknown): HybridReplayRecord {
  if (!input || typeof input !== 'object') throw new Error('Replay record must be an object');
  const value = input as Record<string, unknown>;
  const fixtureId = value['fixtureId'];
  if (typeof fixtureId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(fixtureId))
    throw new Error('Replay fixtureId is invalid');
  const evidenceIds = stringArray(value['evidenceIds'], 'evidenceIds', 5, 64);
  const rawAssessment = value['assessment'];
  if (!rawAssessment || typeof rawAssessment !== 'object')
    throw new Error('Assessment is required');
  const assessment = rawAssessment as Record<string, unknown>;
  const evidenceRefs = stringArray(assessment['evidenceRefs'], 'evidenceRefs', 5, 64);
  if (
    typeof assessment['incidentStage'] !== 'string' ||
    !STAGES.has(assessment['incidentStage']) ||
    typeof assessment['riskTier'] !== 'string' ||
    !RISKS.has(assessment['riskTier']) ||
    typeof assessment['confidence'] !== 'number' ||
    assessment['confidence'] < 0 ||
    assessment['confidence'] > 1 ||
    typeof assessment['needsFollowUp'] !== 'boolean'
  )
    throw new Error('Assessment fields are invalid');
  if (evidenceRefs.some((id) => !evidenceIds.includes(id)))
    throw new Error('Assessment evidence references must be present in the record evidenceIds');
  const policyOutcomes = Array.isArray(value['policyOutcomes'])
    ? value['policyOutcomes'].map(policyOutcome)
    : (() => {
        throw new Error('Replay policy outcomes are invalid');
      })();
  const fallbackOptionalActions = actionArray(
    value['fallbackOptionalActions'],
    'fallbackOptionalActions',
    true,
  );
  const finalOptionalActions = actionArray(
    value['finalOptionalActions'],
    'finalOptionalActions',
    true,
  );
  const actionOrigins = originArray(value['actionOrigins']);
  if (actionOrigins.length !== finalOptionalActions.length)
    throw new Error('Replay action provenance is invalid');
  return {
    fixtureId,
    evidenceIds,
    assessment: {
      incidentStage: assessment['incidentStage'],
      riskTier: assessment['riskTier'],
      confidence: assessment['confidence'],
      hypothesis: boundedText(assessment['hypothesis'], 'hypothesis', 500),
      evidenceRefs,
      recommendedActions: recommendationArray(
        assessment['recommendedActions'],
        'recommendedActions',
      ),
      rationale: boundedText(assessment['rationale'], 'rationale', 1000),
      needsFollowUp: assessment['needsFollowUp'],
    },
    policyOutcomes,
    fallbackOptionalActions,
    finalOptionalActions,
    actionOrigins,
  } as HybridReplayRecord;
}
function parseEvidence(input: unknown): HybridReplayEvidence {
  if (!input || typeof input !== 'object')
    throw new Error('Hybrid replay evidence must be an object');
  const value = input as Record<string, unknown>;
  if (
    value['replaySchemaVersion'] !== HYBRID_REPLAY_VERSION ||
    value['source'] !== 'hybrid-synthetic' ||
    typeof value['fixtureSetVersion'] !== 'string' ||
    !Array.isArray(value['records'])
  )
    throw new Error('Hybrid replay evidence metadata is invalid');
  return {
    replaySchemaVersion: HYBRID_REPLAY_VERSION,
    fixtureSetVersion: value['fixtureSetVersion'],
    source: 'hybrid-synthetic',
    records: value['records'].map(record),
  };
}

export function captureHybridEvidence(
  input: CaptureInput,
  fixtures: readonly ReplayFixtureDefinition[],
): HybridReplayEvidence {
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const seen = new Set<string>();
  const records = input.records.map((raw) => {
    if (seen.has(raw.fixtureId)) throw new Error(`Duplicate capture fixtureId: ${raw.fixtureId}`);
    seen.add(raw.fixtureId);
    const fixture = fixtureById.get(raw.fixtureId);
    if (!fixture) throw new Error(`Capture references unknown fixture: ${raw.fixtureId}`);
    const evidenceIds = [
      ...new Set(raw.evidenceIds.map((id) => boundedText(id, 'evidenceId', 64))),
    ];
    if (evidenceIds.some((id) => !fixture.evidenceIds.includes(id)))
      throw new Error(`${raw.fixtureId} contains evidence outside its fixture evidence set`);
    return record({
      fixtureId: raw.fixtureId,
      evidenceIds,
      assessment: raw.assessment,
      policyOutcomes: raw.policyOutcomes ?? [],
      fallbackOptionalActions: raw.fallbackOptionalActions,
      finalOptionalActions: raw.finalOptionalActions,
      actionOrigins: raw.actionOrigins,
    });
  });
  if (records.length !== fixtures.length)
    throw new Error(`Expected one capture record for each of ${fixtures.length} fixtures`);
  if (seen.size !== fixtureById.size)
    throw new Error('Capture is incomplete: every fixture requires a replay record');
  return {
    replaySchemaVersion: HYBRID_REPLAY_VERSION,
    fixtureSetVersion: input.fixtureSetVersion ?? 'ai-value-v1',
    source: 'hybrid-synthetic',
    records,
  };
}
export function replayHybridEvidence(
  evidence: unknown,
  fixtures: readonly ReplayFixtureDefinition[],
): ReplayReport {
  const parsed = parseEvidence(evidence);
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  if (parsed.records.length !== fixtures.length)
    throw new Error(
      `Replay contains ${parsed.records.length} records; expected ${fixtures.length}`,
    );
  const seen = new Set<string>();
  let policyOutcomeCount = 0;
  let eligibleCount = 0;
  let influencedCount = 0;
  const reports = parsed.records.map((item) => {
    if (seen.has(item.fixtureId)) throw new Error(`Duplicate replay fixtureId: ${item.fixtureId}`);
    seen.add(item.fixtureId);
    const fixture = fixtureById.get(item.fixtureId);
    if (!fixture) throw new Error(`Replay references unknown fixture: ${item.fixtureId}`);
    if (item.evidenceIds.some((id) => !fixture.evidenceIds.includes(id)))
      throw new Error(`${item.fixtureId} contains evidence outside its fixture evidence set`);
    policyOutcomeCount += item.policyOutcomes.length;
    const eligible = fixture.fallbackOptionalActions.length > 0;
    const influenced =
      eligible &&
      item.finalOptionalActions.toSorted().join('|') !==
        fixture.fallbackOptionalActions.toSorted().join('|') &&
      item.actionOrigins.includes('MODEL_REQUEST');
    if (eligible) eligibleCount++;
    if (influenced) influencedCount++;
    return {
      fixtureId: item.fixtureId,
      assessmentValid: true as const,
      evidenceRefs: item.assessment.evidenceRefs,
      policyOutcomes: item.policyOutcomes.map((outcome) => `${outcome.action}:${outcome.outcome}`),
      modelInfluenced: influenced,
    };
  });
  if (seen.size !== fixtureById.size)
    throw new Error('Replay is incomplete: fixture records are missing');
  return {
    replaySchemaVersion: parsed.replaySchemaVersion,
    fixtureSetVersion: parsed.fixtureSetVersion,
    fixtureCount: reports.length,
    assessmentCount: reports.length,
    policyOutcomeCount,
    modelInfluenceEligibleCount: eligibleCount,
    modelInfluenceCount: influencedCount,
    records: reports,
  };
}
export function readFixtureDefinitions(path: string): ReplayFixtureDefinition[] {
  const input = JSON.parse(readFileSync(path, 'utf8')) as { fixtures?: ReplayFixtureDefinition[] };
  if (!Array.isArray(input.fixtures)) throw new Error('Fixture set must contain a fixtures array');
  return input.fixtures;
}
export function readCaptureInput(path: string): CaptureInput {
  const input = JSON.parse(readFileSync(path, 'utf8')) as
    CaptureInput | readonly CaptureRecordInput[];
  return Array.isArray(input) ? { records: [...input] } : (input as CaptureInput);
}
export function writeJson(path: string, value: unknown): void {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
