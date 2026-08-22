import { randomUUID } from 'node:crypto';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  type SimulatedDeceptionEffect,
  DegradedModelResultSchema,
  SimulatedDeceptionCommandSchema,
  SimulatedDeceptionResultSchema,
  SimulatedDeceptionEffectSchema,
} from '@false-route/contracts';
import { type Logger, withCorrelationContext } from '@false-route/observability';
import { type WorkerRepository } from '../persistence/worker-repository.js';
import { type GeminiEnrichmentAdapter } from '../adapters/gemini-adapter.js';
import { type SimulatedDeceptionAgent } from '../adapters/simulated-deception-agent.js';
import { classifyProviderError } from '../adapters/error-classifier.js';
import { evaluateDeceptionPolicy } from '../domain/policy-engine.js';

export interface EventProcessorOptions {
  readonly repository: WorkerRepository;
  readonly geminiAdapter: GeminiEnrichmentAdapter;
  readonly simulatedAgent: SimulatedDeceptionAgent;
  readonly logger: Logger;
}

export interface ProcessResult {
  readonly processed: boolean;
  readonly decision?: DeceptionDecision | undefined;
  readonly eventId?: string | undefined;
}

/**
 * Orchestrates event lifecycle: claiming, bounded model enrichment,
 * deterministic policy evaluation, simulated deception recording, and atomic decision persistence.
 */
export class EventProcessor {
  private readonly repository: WorkerRepository;
  private readonly geminiAdapter: GeminiEnrichmentAdapter;
  private readonly simulatedAgent: SimulatedDeceptionAgent;
  private readonly logger: Logger;

  constructor(options: EventProcessorOptions) {
    this.repository = options.repository;
    this.geminiAdapter = options.geminiAdapter;
    this.simulatedAgent = options.simulatedAgent;
    this.logger = options.logger;
  }

  async processEvent(event: IntrusionEvent, claimToken: string): Promise<DeceptionDecision> {
    const eventLogger = withCorrelationContext(this.logger, {
      correlationId: event.correlationId,
      eventId: event.id,
    });

    eventLogger.info({ eventType: event.eventType }, 'Beginning worker processing for event');

    // 1. Optional bounded model enrichment
    let enrichment: ModelEnrichmentResult | DegradedModelResult;
    try {
      enrichment = await this.geminiAdapter.enrichEvent(event);
      if (enrichment.correlationId !== event.correlationId) {
        eventLogger.warn(
          'Model enrichment returned mismatched correlationId; degrading gracefully',
        );
        enrichment = DegradedModelResultSchema.parse({
          correlationId: event.correlationId,
          status: 'INVALID_OUTPUT',
          reason: 'Model adapter returned mismatched correlationId',
          provenance: 'UNAVAILABLE',
          evaluatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const classified = classifyProviderError(err);
      eventLogger.warn(
        {
          providerErrorKind: classified.kind,
          providerStatus: classified.status,
          ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
        },
        'Model enrichment failed; degrading gracefully',
      );
      enrichment = DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: classified.status,
        reason: classified.sanitizedReason,
        provenance: 'UNAVAILABLE',
        evaluatedAt: new Date().toISOString(),
      });
    }

    // 2. Deterministic policy evaluation (pure domain)
    const decisionId = randomUUID();
    let decision: DeceptionDecision;
    try {
      decision = evaluateDeceptionPolicy({
        event,
        enrichment,
        decisionId,
      });
    } catch (policyErr) {
      const errorType = policyErr instanceof Error ? policyErr.constructor.name : 'UnknownError';
      eventLogger.warn(
        { errorType },
        'Policy evaluation with enrichment failed; falling back to degraded enrichment',
      );
      const fallbackEnrichment = DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'INVALID_OUTPUT',
        reason: 'Policy evaluation with enrichment rejected input',
        provenance: 'UNAVAILABLE',
        evaluatedAt: new Date().toISOString(),
      });
      decision = evaluateDeceptionPolicy({
        event,
        enrichment: fallbackEnrichment,
        decisionId,
      });
    }

    // 3. Constrained simulated deception command recording
    let simulatedEffect: SimulatedDeceptionEffect | undefined;
    if (decision.action === 'ASSIGN_FALSE_ROUTE') {
      const command = SimulatedDeceptionCommandSchema.parse({
        decisionId: decision.id,
        correlationId: decision.correlationId,
        action: 'ASSIGN_FALSE_ROUTE',
        containmentMode: 'SIMULATED',
        assignedFalseRoute: decision.assignedFalseRoute,
        commandProvenance: 'DERIVED',
      });

      const agentResult = await this.simulatedAgent.recordCommand(command);
      const validatedResult = SimulatedDeceptionResultSchema.parse(agentResult);

      simulatedEffect = SimulatedDeceptionEffectSchema.parse({
        id: randomUUID(),
        decisionId: decision.id,
        correlationId: decision.correlationId,
        effectKind: 'ASSIGN_FALSE_ROUTE',
        status: validatedResult.status,
        containmentMode: 'SIMULATED',
        assignedFalseRoute: decision.assignedFalseRoute,
        provenance: validatedResult.provenance,
        recordedAt: validatedResult.recordedAt,
        adapterVersion: validatedResult.adapterVersion,
      });
    }

    // 4. Atomic persistence of decision, audit record, and optional simulated effect
    await this.repository.persistDecision(decision, claimToken, simulatedEffect);

    eventLogger.info(
      {
        decisionId: decision.id,
        action: decision.action,
        matchedPolicy: decision.matchedPolicy,
        containmentMode: decision.containmentMode,
        ...(simulatedEffect
          ? {
              simulatedEffectStatus: simulatedEffect.status,
              adapterVersion: simulatedEffect.adapterVersion,
            }
          : {}),
      },
      'Deterministic deception decision and simulated effect evidence persisted successfully',
    );

    return decision;
  }

  async processNextPending(): Promise<ProcessResult> {
    const claim = await this.repository.claimNextPendingEvent();
    if (!claim) {
      return { processed: false };
    }

    const { event, claimToken } = claim;

    try {
      const decision = await this.processEvent(event, claimToken);
      return {
        processed: true,
        decision,
        eventId: event.id,
      };
    } catch (err) {
      let outcome = 'UNKNOWN';
      try {
        outcome = await this.repository.releaseOrFailClaim(event.id, claimToken);
      } catch {
        outcome = 'ERROR_RELEASING';
      }

      this.logger.error(
        { eventId: event.id, correlationId: event.correlationId, outcome },
        'Worker failed to complete processing for claimed event',
      );
      throw err;
    }
  }
}
