import { randomUUID } from 'node:crypto';
import {
  type IntrusionEvent,
  type DeceptionDecision,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  DegradedModelResultSchema,
} from '@false-route/contracts';
import { type Logger, withCorrelationContext } from '@false-route/observability';
import { type WorkerRepository } from '../persistence/worker-repository.js';
import { type GeminiEnrichmentAdapter } from '../adapters/gemini-adapter.js';
import { evaluateDeceptionPolicy } from '../domain/policy-engine.js';

export interface EventProcessorOptions {
  readonly repository: WorkerRepository;
  readonly geminiAdapter: GeminiEnrichmentAdapter;
  readonly logger: Logger;
}

export interface ProcessResult {
  readonly processed: boolean;
  readonly decision?: DeceptionDecision | undefined;
  readonly eventId?: string | undefined;
}

/**
 * Orchestrates event lifecycle: claiming, bounded model enrichment,
 * deterministic policy evaluation, and atomic decision persistence.
 */
export class EventProcessor {
  private readonly repository: WorkerRepository;
  private readonly geminiAdapter: GeminiEnrichmentAdapter;
  private readonly logger: Logger;

  constructor(options: EventProcessorOptions) {
    this.repository = options.repository;
    this.geminiAdapter = options.geminiAdapter;
    this.logger = options.logger;
  }

  async processEvent(event: IntrusionEvent): Promise<DeceptionDecision> {
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
          { expected: event.correlationId, received: enrichment.correlationId },
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
      const errorMessage = err instanceof Error ? err.message : 'Unknown model adapter error';
      eventLogger.warn({ error: errorMessage }, 'Model enrichment failed; degrading gracefully');
      enrichment = DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Adapter failed to execute model enrichment',
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
      eventLogger.warn(
        { error: policyErr instanceof Error ? policyErr.message : 'Policy evaluation error' },
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

    // 3. Atomic persistence of decision and audit record
    await this.repository.persistDecision(decision);

    eventLogger.info(
      {
        decisionId: decision.id,
        action: decision.action,
        matchedPolicy: decision.matchedPolicy,
        containmentMode: decision.containmentMode,
      },
      'Deterministic deception decision persisted successfully',
    );

    return decision;
  }

  async processNextPending(): Promise<ProcessResult> {
    const event = await this.repository.claimNextPendingEvent();
    if (!event) {
      return { processed: false };
    }

    try {
      const decision = await this.processEvent(event);
      return {
        processed: true,
        decision,
        eventId: event.id,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown worker processing error';
      this.logger.error(
        { eventId: event.id, correlationId: event.correlationId, error: errorMsg },
        'Worker failed to process claimed event; marking FAILED',
      );
      await this.repository.markEventFailed(event.id);
      throw err;
    }
  }
}
