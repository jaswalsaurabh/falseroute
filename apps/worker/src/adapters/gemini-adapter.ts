import { GoogleGenAI } from '@google/genai';
import { ZodError } from 'zod';
import {
  type IntrusionEvent,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  ModelEnrichmentResultSchema,
  DegradedModelResultSchema,
} from '@false-route/contracts';

export interface GeminiAdapterOptions {
  readonly apiKey: string;
  readonly modelName: string;
  readonly timeoutMs?: number;
}

export interface GeminiEnrichmentAdapter {
  enrichEvent(event: IntrusionEvent): Promise<ModelEnrichmentResult | DegradedModelResult>;
}

/**
 * Adapter integrating Google Gen AI SDK with strict schema decoding,
 * prompt bounding, and fallback to degraded states on timeout or failure.
 */
export class LiveGeminiAdapter implements GeminiEnrichmentAdapter {
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly timeoutMs: number;

  constructor(options: GeminiAdapterOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.modelName = options.modelName;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async enrichEvent(event: IntrusionEvent): Promise<ModelEnrichmentResult | DegradedModelResult> {
    const evaluatedAt = new Date().toISOString();

    const minimizedInput = {
      eventType: event.eventType,
      targetAsset: event.targetAsset,
      failedLoginCount: event.failedLoginCount,
      riskIndicators: event.riskIndicators,
      usedDecoyCredential: event.usedDecoyCredential,
    };

    const systemInstruction = `You are a cybersecurity deception assistant evaluating a simulated intrusion event.
Analyze the event and provide a structured JSON assessment adhering to:
- recommendedAction: must be one of "ASSIGN_FALSE_ROUTE", "ALLOW", "ALERT_OPERATOR", "OBSERVE"
- suggestedFalseRoute: "mock-admin-decoy" if recommending ASSIGN_FALSE_ROUTE, omit otherwise
- confidence: number between 0.0 and 1.0
- summary: concise description (max 500 chars)
- explanation: detailed reasoning (max 2000 chars)

Return ONLY valid JSON.`;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Gemini request exceeded deadline of ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      // Execute request with bounded tokens and deadline
      const responsePromise = this.client.models.generateContent({
        model: this.modelName,
        contents: [
          {
            role: 'user',
            parts: [{ text: JSON.stringify(minimizedInput) }],
          },
        ],
        config: {
          abortSignal: abortController.signal,
          systemInstruction,
          responseMimeType: 'application/json',
          maxOutputTokens: 1024,
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(abortController.signal.reason ?? new Error('Gemini request timeout'));
        });
      });

      const response = await Promise.race([responsePromise, timeoutPromise]);
      const rawText = response.text?.trim() ?? '';

      if (!rawText) {
        return DegradedModelResultSchema.parse({
          correlationId: event.correlationId,
          status: 'INVALID_OUTPUT',
          reason: 'Gemini returned empty response text',
          provenance: 'UNAVAILABLE',
          evaluatedAt,
        });
      }

      const parsedJson = JSON.parse(rawText) as Record<string, unknown>;

      // Attach trusted adapter-owned metadata
      const rawEnrichment = {
        recommendedAction: parsedJson.recommendedAction,
        suggestedFalseRoute: parsedJson.suggestedFalseRoute,
        confidence: parsedJson.confidence,
        summary: parsedJson.summary,
        explanation: parsedJson.explanation,
        provenance: 'INFERRED' as const,
        correlationId: event.correlationId,
        modelIdentifier: this.modelName,
        evaluatedAt,
      };

      return ModelEnrichmentResultSchema.parse(rawEnrichment);
    } catch (err) {
      const isTimeout =
        (err instanceof Error &&
          (err.message.includes('deadline') ||
            err.message.includes('timeout') ||
            err.name === 'AbortError')) ||
        abortController.signal.aborted;
      const isSyntax = err instanceof SyntaxError;
      const isZodError = err instanceof ZodError;
      const isInvalidOutput = isSyntax || isZodError;

      const status = isTimeout ? 'TIMEOUT' : isInvalidOutput ? 'INVALID_OUTPUT' : 'UNAVAILABLE';
      const reason = isTimeout
        ? `Gemini request exceeded deadline of ${this.timeoutMs}ms`
        : isSyntax
          ? 'Gemini returned non-JSON or invalid structured syntax'
          : isZodError
            ? `Gemini returned schema-invalid structured output: ${err.message}`
            : err instanceof Error
              ? `Gemini upstream error: ${err.message}`
              : 'Gemini upstream service unavailable';

      return DegradedModelResultSchema.parse({
        correlationId: event.correlationId,
        status,
        reason: reason.slice(0, 500),
        provenance: 'UNAVAILABLE',
        evaluatedAt,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
