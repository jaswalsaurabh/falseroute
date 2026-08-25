import {
  IncidentContextSchema,
  IncidentEvidenceReferenceSchema,
  IncidentSignalSummarySchema,
  type IncidentContext,
  type IncidentEvidenceReference,
  type IncidentSignalSummary,
  type IntrusionEventEnvelope,
  type PriorPolicyOutcome,
  type SimulatedLeaseSummary,
} from '@false-route/contracts';

const MAX_SIGNALS = 5;
const MAX_CONTEXT_BYTES = 16_384;

export interface RelatedIncidentSignal {
  readonly signalId: string;
  readonly correlationId: string;
  readonly syntheticSource: string;
  readonly scenarioKind: IncidentSignalSummary['scenarioKind'];
  readonly summary: string;
  readonly observedAt: string;
  readonly evidence: readonly IncidentEvidenceReference[];
  readonly priorPolicyOutcomes?: readonly PriorPolicyOutcome[] | undefined;
  readonly activeLeases?: readonly SimulatedLeaseSummary[] | undefined;
}

/**
 * Read-only worker port. Implementations must return records for the supplied
 * correlation/source scope; the service still re-checks that boundary.
 */
export interface IncidentContextRecordPort {
  findRelatedSignals(params: {
    readonly correlationId: string;
    readonly syntheticSource: string;
    readonly excludeEventId: string;
  }): Promise<readonly RelatedIncidentSignal[]>;
}

export interface IncidentContextRequest {
  readonly currentEvent: IntrusionEventEnvelope;
  readonly syntheticSource: string;
  readonly currentSummary: string;
  readonly campaignId?: string | undefined;
  readonly campaignStep?: number | undefined;
  readonly campaignTotalSteps?: number | undefined;
}

export type IncidentContextBuildResult =
  | { readonly status: 'SUCCESS'; readonly context: IncidentContext }
  | {
      readonly status: 'DEGRADED';
      readonly reason: 'REPOSITORY_ERROR' | 'CONTEXT_TOO_LARGE' | 'INVALID_RECORD';
      readonly message: string;
    };

export class IncidentContextService {
  constructor(private readonly records: IncidentContextRecordPort) {}

  async build(request: IncidentContextRequest): Promise<IncidentContextBuildResult> {
    const currentEvidence = this.buildCurrentEvidence(request);
    const currentSignal = this.buildCurrentSignal(request, currentEvidence);

    let related: readonly RelatedIncidentSignal[];
    try {
      related = await this.records.findRelatedSignals({
        correlationId: request.currentEvent.correlationId,
        syntheticSource: request.syntheticSource,
        excludeEventId: request.currentEvent.eventId,
      });
    } catch (error) {
      return {
        status: 'DEGRADED',
        reason: 'REPOSITORY_ERROR',
        message: `Unable to read related incident signals: ${errorMessage(error)}`,
      };
    }

    const parsedRelatedSignals = related
      .filter(
        (record) =>
          record.correlationId === request.currentEvent.correlationId &&
          record.syntheticSource === request.syntheticSource &&
          record.signalId !== request.currentEvent.eventId,
      )
      .map((record) => this.parseRelatedRecord(record));

    if (parsedRelatedSignals.some((record) => !record.success)) {
      return {
        status: 'DEGRADED',
        reason: 'INVALID_RECORD',
        message: 'Related incident signal failed bounded contract validation',
      };
    }

    const uniqueSignals = deduplicateSignals(
      parsedRelatedSignals
        .flatMap((record) => (record.success ? [record.data] : []))
        .toSorted(compareSignals),
    );
    const selectedSignals = [currentSignal, ...uniqueSignals].slice(0, MAX_SIGNALS);
    const evidence = deduplicateEvidence(
      selectedSignals.flatMap((signal) => signal.evidence),
    ).slice(0, 5);
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    const boundedSignals = selectedSignals
      .map((signal) =>
        Object.assign({}, signal, {
          evidence: signal.evidence.filter((item) => evidenceIds.has(item.evidenceId)),
        }),
      )
      .filter((signal) => signal.evidence.length > 0);
    const contextCompleteness =
      uniqueSignals.length === 0
        ? 'INSUFFICIENT'
        : uniqueSignals.length > MAX_SIGNALS - 1
          ? 'PARTIAL'
          : 'COMPLETE';
    const context = {
      contextSchemaVersion: '1.0.0' as const,
      currentEventId: request.currentEvent.eventId,
      correlationId: request.currentEvent.correlationId,
      scenarioKind: request.currentEvent.scenarioKind,
      syntheticSource: request.syntheticSource,
      signals: boundedSignals.map((signal) => ({
        signalId: signal.signalId,
        scenarioKind: signal.scenarioKind,
        summary: signal.summary,
        observedAt: signal.observedAt,
        evidenceRefs: signal.evidence.map((item) => item.evidenceId),
      })),
      evidence,
      priorPolicyOutcomes: uniqueSignals
        .flatMap((signal) => signal.priorPolicyOutcomes ?? [])
        .slice(0, 5),
      activeLeases: uniqueSignals.flatMap((signal) => signal.activeLeases ?? []).slice(0, 5),
      ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
      ...(request.campaignStep === undefined ? {} : { campaignStep: request.campaignStep }),
      ...(request.campaignTotalSteps === undefined
        ? {}
        : { campaignTotalSteps: request.campaignTotalSteps }),
      contextCompleteness,
    };

    const parsed = IncidentContextSchema.safeParse(context);
    if (!parsed.success) {
      return {
        status: 'DEGRADED',
        reason: 'INVALID_RECORD',
        message: 'Incident context failed bounded contract validation',
      };
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_CONTEXT_BYTES) {
      return {
        status: 'DEGRADED',
        reason: 'CONTEXT_TOO_LARGE',
        message: `Incident context exceeds the ${MAX_CONTEXT_BYTES}-byte payload ceiling`,
      };
    }
    return { status: 'SUCCESS', context: parsed.data };
  }

  private buildCurrentEvidence(request: IncidentContextRequest): IncidentEvidenceReference[] {
    return [
      IncidentEvidenceReferenceSchema.parse({
        evidenceId: `${request.currentEvent.eventId}:observation`,
        evidenceType: request.currentEvent.scenarioKind,
        observedAt: request.currentEvent.occurredAt,
        provenance: request.currentEvent.provenance,
      }),
    ];
  }

  private buildCurrentSignal(
    request: IncidentContextRequest,
    evidence: readonly IncidentEvidenceReference[],
  ): RelatedIncidentSignal {
    return {
      signalId: request.currentEvent.eventId,
      correlationId: request.currentEvent.correlationId,
      syntheticSource: request.syntheticSource,
      scenarioKind: request.currentEvent.scenarioKind,
      summary: request.currentSummary,
      observedAt: request.currentEvent.occurredAt,
      evidence,
    };
  }

  private parseRelatedRecord(
    record: RelatedIncidentSignal,
  ):
    { readonly success: true; readonly data: RelatedIncidentSignal } | { readonly success: false } {
    const signal = IncidentSignalSummarySchema.safeParse({
      signalId: record.signalId,
      scenarioKind: record.scenarioKind,
      summary: record.summary,
      observedAt: record.observedAt,
      evidenceRefs: record.evidence.map((item) => item.evidenceId),
    });
    const evidence = record.evidence.every(
      (item) => IncidentEvidenceReferenceSchema.safeParse(item).success,
    );
    if (!signal.success || !evidence) return { success: false };
    return { success: true, data: record };
  }
}

function compareSignals(left: RelatedIncidentSignal, right: RelatedIncidentSignal): number {
  const timeOrder = right.observedAt.localeCompare(left.observedAt);
  return timeOrder !== 0 ? timeOrder : left.signalId.localeCompare(right.signalId);
}

function deduplicateSignals(signals: readonly RelatedIncidentSignal[]): RelatedIncidentSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (seen.has(signal.signalId)) return false;
    seen.add(signal.signalId);
    return true;
  });
}

function deduplicateEvidence(
  evidence: readonly IncidentEvidenceReference[],
): IncidentEvidenceReference[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.evidenceId)) return false;
    seen.add(item.evidenceId);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown repository failure';
}
