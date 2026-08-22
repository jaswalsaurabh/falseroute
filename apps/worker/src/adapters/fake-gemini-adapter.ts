import {
  type IntrusionEvent,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  ModelEnrichmentResultSchema,
  DegradedModelResultSchema,
} from '@false-route/contracts';
import { type GeminiEnrichmentAdapter } from './gemini-adapter.js';

export type FakeAdapterMode =
  | 'auto'
  | 'decoy-recommendation'
  | 'observe-recommendation'
  | 'alert-recommendation'
  | 'timeout'
  | 'unavailable'
  | 'invalid-output'
  | 'conflicting-recommendation'
  | 'rate-limited'
  | 'server-error'
  | 'terminal-auth-error'
  | 'concurrency-saturation'
  | 'slow-response';

export interface FakeAdapterOptions {
  readonly mode?: FakeAdapterMode;
  readonly modelIdentifier?: string;
  readonly delayMs?: number;
  readonly transientFailuresBeforeSuccess?: number;
}

export class FakeGeminiAdapter implements GeminiEnrichmentAdapter {
  private mode: FakeAdapterMode;
  private readonly modelIdentifier: string;
  private readonly delayMs: number;
  private transientFailuresRemaining: number;
  public callCount = 0;

  constructor(
    modeOrOptions: FakeAdapterMode | FakeAdapterOptions = 'auto',
    modelIdentifier = 'gemini-3.5-fake',
  ) {
    if (typeof modeOrOptions === 'string') {
      this.mode = modeOrOptions;
      this.modelIdentifier = modelIdentifier;
      this.delayMs = 0;
      this.transientFailuresRemaining = 0;
    } else {
      this.mode = modeOrOptions.mode ?? 'auto';
      this.modelIdentifier = modeOrOptions.modelIdentifier ?? modelIdentifier;
      this.delayMs = modeOrOptions.delayMs ?? 0;
      this.transientFailuresRemaining = modeOrOptions.transientFailuresBeforeSuccess ?? 0;
    }
  }

  setMode(mode: FakeAdapterMode): void {
    this.mode = mode;
  }

  setTransientFailuresRemaining(count: number): void {
    this.transientFailuresRemaining = count;
  }

  async enrichEvent(
    event: IntrusionEvent,
    parentSignal?: AbortSignal,
  ): Promise<ModelEnrichmentResult | DegradedModelResult> {
    this.callCount++;

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (parentSignal?.aborted) {
          reject(parentSignal.reason ?? new Error('Aborted'));
          return;
        }
        const timer = setTimeout(resolve, this.delayMs);
        parentSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(parentSignal.reason ?? new Error('Aborted'));
          },
          { once: true },
        );
      });
    }

    const evaluatedAt = new Date().toISOString();

    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining--;
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Simulated transient upstream 503 error',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'timeout') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'TIMEOUT',
        reason: 'Simulated fake timeout after deadline',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'rate-limited') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Simulated rate limit quota exceeded (HTTP 429)',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'server-error') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Simulated internal server error (HTTP 503)',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'terminal-auth-error') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Simulated authentication failure (HTTP 401)',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'concurrency-saturation') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'Provider concurrency limit saturated',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'unavailable') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'UNAVAILABLE',
        reason: 'AI enrichment service unavailable or GEMINI_API_KEY not configured',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'invalid-output') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'INVALID_OUTPUT',
        reason: 'Simulated fake invalid structured JSON schema',
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    }

    if (this.mode === 'conflicting-recommendation') {
      return ModelEnrichmentResultSchema.parse({
        correlationId: event.correlationId,
        confidence: 0.88,
        summary: 'Conflicting AI recommendation to assign false route',
        explanation: 'AI model suggests false route redirection on standard traffic',
        provenance: 'INFERRED',
        modelIdentifier: this.modelIdentifier,
        evaluatedAt,
        recommendedAction: 'ASSIGN_FALSE_ROUTE',
        suggestedFalseRoute: 'mock-admin-decoy',
      });
    }

    const shouldRecommendRoute =
      this.mode === 'decoy-recommendation' || (this.mode === 'auto' && event.usedDecoyCredential);

    if (shouldRecommendRoute) {
      return ModelEnrichmentResultSchema.parse({
        correlationId: event.correlationId,
        confidence: 0.96,
        summary: 'Decoy credential detected accessing mock admin portal',
        explanation:
          'Observed access using known decoy credential mock-admin-decoy-creds. Recommending false-route containment.',
        provenance: 'INFERRED',
        modelIdentifier: this.modelIdentifier,
        evaluatedAt,
        recommendedAction: 'ASSIGN_FALSE_ROUTE',
        suggestedFalseRoute: 'mock-admin-decoy',
      });
    }

    return ModelEnrichmentResultSchema.parse({
      correlationId: event.correlationId,
      confidence: 0.75,
      summary: 'Suspicious login event without decoy credential',
      explanation:
        'Standard access anomaly observed. Recommending continued observation under simulated mode.',
      provenance: 'INFERRED',
      modelIdentifier: this.modelIdentifier,
      evaluatedAt,
      recommendedAction: 'OBSERVE',
    });
  }
}
