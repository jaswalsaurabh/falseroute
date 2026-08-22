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
  | 'conflicting-recommendation';

export class FakeGeminiAdapter implements GeminiEnrichmentAdapter {
  private mode: FakeAdapterMode;
  private readonly modelIdentifier: string;

  constructor(mode: FakeAdapterMode = 'auto', modelIdentifier = 'gemini-3.5-fake') {
    this.mode = mode;
    this.modelIdentifier = modelIdentifier;
  }

  setMode(mode: FakeAdapterMode): void {
    this.mode = mode;
  }

  async enrichEvent(event: IntrusionEvent): Promise<ModelEnrichmentResult | DegradedModelResult> {
    const evaluatedAt = new Date().toISOString();

    if (this.mode === 'timeout') {
      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status: 'TIMEOUT',
        reason: 'Simulated fake timeout after 5000ms',
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
      // Recommends false route even when event does not use decoy credential
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
