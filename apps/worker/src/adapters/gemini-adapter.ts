import { GoogleGenAI } from '@google/genai';
import {
  type IntrusionEvent,
  type ModelEnrichmentResult,
  type DegradedModelResult,
  ModelEnrichmentResultSchema,
  DegradedModelResultSchema,
} from '@false-route/contracts';
import { classifyProviderError, type ClassifiedProviderError } from './error-classifier.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { RetryPolicy, type RetryPolicyOptions } from './retry-policy.js';
import { type GeminiAttemptGate } from '../services/gemini-budget-service.js';

/** Signals that the durable per-event attempt ceiling refused this dispatch. */
class AttemptBudgetExhaustedError extends Error {}

export interface GeminiAdapterOptions extends RetryPolicyOptions {
  readonly apiKey: string;
  readonly modelName: string;
  readonly requestTimeoutMs?: number;
  readonly operationDeadlineMs?: number;
  readonly maxConcurrency?: number;
  readonly maxQueueSize?: number;
}

export interface GeminiEnrichmentAdapter {
  /**
   * `attemptGate` must authorize every real provider dispatch, including internal retries.
   * An adapter that does not retry internally may ignore it.
   */
  enrichEvent(
    event: IntrusionEvent,
    parentSignal?: AbortSignal,
    attemptGate?: GeminiAttemptGate,
  ): Promise<ModelEnrichmentResult | DegradedModelResult>;
}

const DEFAULT_SYSTEM_INSTRUCTION = `You are a cybersecurity deception assistant evaluating a simulated intrusion event.
Analyze the event and provide a structured JSON assessment adhering to:
- recommendedAction: must be one of "ASSIGN_FALSE_ROUTE", "ALLOW", "ALERT_OPERATOR", "OBSERVE"
- suggestedFalseRoute: "mock-admin-decoy" if recommending ASSIGN_FALSE_ROUTE, omit otherwise
- confidence: number between 0.0 and 1.0
- summary: concise description (max 500 chars)
- explanation: detailed reasoning (max 2000 chars)

Return ONLY valid JSON.`;

/**
 * Robust adapter integrating Google Gen AI SDK with strict schema decoding,
 * complete operation deadlines, bounded concurrency, and finite transient retries.
 */
export class LiveGeminiAdapter implements GeminiEnrichmentAdapter {
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly requestTimeoutMs: number;
  private readonly operationDeadlineMs: number;
  private readonly limiter: ConcurrencyLimiter;
  private readonly retryPolicy: RetryPolicy;

  constructor(options: GeminiAdapterOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.modelName = options.modelName;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    this.operationDeadlineMs = options.operationDeadlineMs ?? 8000;
    this.limiter = new ConcurrencyLimiter({
      maxConcurrency: options.maxConcurrency ?? 2,
      maxQueueSize: options.maxQueueSize ?? 0,
    });
    this.retryPolicy = new RetryPolicy(options);
  }

  async enrichEvent(
    event: IntrusionEvent,
    parentSignal?: AbortSignal,
    attemptGate?: GeminiAttemptGate,
  ): Promise<ModelEnrichmentResult | DegradedModelResult> {
    const evaluatedAt = new Date().toISOString();
    const deadlineAt = Date.now() + this.operationDeadlineMs;

    const operationController = new AbortController();
    const operationTimeoutId = setTimeout(() => {
      operationController.abort(
        new Error(
          `Gemini complete operation deadline exceeded after ${this.operationDeadlineMs}ms`,
        ),
      );
    }, this.operationDeadlineMs);

    const onParentAbort = () => {
      operationController.abort(parentSignal?.reason ?? new Error('Parent operation aborted'));
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    try {
      return await this.limiter.execute(async (limiterSignal) => {
        return this.executeWithRetries(
          event,
          evaluatedAt,
          deadlineAt,
          operationController.signal,
          limiterSignal,
          attemptGate,
        );
      }, operationController.signal);
    } catch (err) {
      const classified = classifyProviderError(err);
      return this.buildDegradedResult(event.correlationId, classified, evaluatedAt);
    } finally {
      clearTimeout(operationTimeoutId);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  private async executeWithRetries(
    event: IntrusionEvent,
    evaluatedAt: string,
    deadlineAt: number,
    operationSignal: AbortSignal,
    limiterSignal?: AbortSignal,
    attemptGate?: GeminiAttemptGate,
  ): Promise<ModelEnrichmentResult | DegradedModelResult> {
    const minimizedInput = {
      eventType: event.eventType,
      targetAsset: event.targetAsset,
      failedLoginCount: event.failedLoginCount,
      riskIndicators: event.riskIndicators,
      usedDecoyCredential: event.usedDecoyCredential,
    };

    let lastClassified: ClassifiedProviderError | null = null;

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
      const remainingOperationMs = deadlineAt - Date.now();

      if (remainingOperationMs <= 0 || operationSignal.aborted) {
        const timeoutClassification: ClassifiedProviderError = {
          kind: 'TIMEOUT',
          isRetriable: false,
          status: 'TIMEOUT',
          sanitizedReason: `Gemini complete operation deadline exceeded after ${this.operationDeadlineMs}ms`,
        };
        return this.buildDegradedResult(event.correlationId, timeoutClassification, evaluatedAt);
      }

      const attemptTimeoutMs = Math.min(this.requestTimeoutMs, remainingOperationMs);
      const attemptController = new AbortController();
      const attemptTimerId = setTimeout(() => {
        attemptController.abort(
          new Error(`Gemini single-request timeout exceeded (${attemptTimeoutMs}ms)`),
        );
      }, attemptTimeoutMs);

      const abortAttempt = () => {
        attemptController.abort(operationSignal.reason ?? new Error('Operation aborted'));
      };

      operationSignal.addEventListener('abort', abortAttempt, { once: true });
      if (limiterSignal && limiterSignal !== operationSignal) {
        limiterSignal.addEventListener('abort', abortAttempt, { once: true });
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (attemptController.signal.aborted) {
          reject(attemptController.signal.reason ?? new Error('Request aborted'));
          return;
        }
        attemptController.signal.addEventListener(
          'abort',
          () => {
            reject(attemptController.signal.reason ?? new Error('Request aborted'));
          },
          { once: true },
        );
      });

      try {
        // Each real dispatch — retries included — needs its own durable reservation, so the
        // retry loop stops here rather than making a call the budget has not accounted for.
        if (attemptGate) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await attemptGate.beginAttempt();
          } catch (gateErr) {
            throw new AttemptBudgetExhaustedError(
              gateErr instanceof Error ? gateErr.message : String(gateErr),
            );
          }
        }

        const responsePromise = this.client.models.generateContent({
          model: this.modelName,
          contents: [
            {
              role: 'user',
              parts: [{ text: JSON.stringify(minimizedInput) }],
            },
          ],
          config: {
            abortSignal: attemptController.signal,
            systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            // Keep deterministic sampling and leave headroom for the bounded explanation so a
            // valid JSON object is not truncated at the provider boundary.
            temperature: 0,
            maxOutputTokens: 2048,
          },
        });

        // eslint-disable-next-line no-await-in-loop
        const response = await Promise.race([responsePromise, abortPromise]);
        const rawText = response.text?.trim() ?? '';

        if (!rawText) {
          return this.buildDegradedResult(
            event.correlationId,
            {
              kind: 'SCHEMA_INVALID',
              isRetriable: false,
              status: 'INVALID_OUTPUT',
              sanitizedReason: 'Gemini returned empty response text',
            },
            evaluatedAt,
          );
        }

        const parsedJson = JSON.parse(rawText) as Record<string, unknown>;
        return ModelEnrichmentResultSchema.parse({
          recommendedAction: parsedJson['recommendedAction'],
          suggestedFalseRoute: parsedJson['suggestedFalseRoute'],
          confidence: parsedJson['confidence'],
          summary: parsedJson['summary'],
          explanation: parsedJson['explanation'],
          provenance: 'INFERRED' as const,
          correlationId: event.correlationId,
          modelIdentifier: this.modelName,
          evaluatedAt,
        });
      } catch (err) {
        if (err instanceof AttemptBudgetExhaustedError) {
          const exhaustedReason = lastClassified
            ? `Gemini attempt budget exhausted after ${lastClassified.status.toLowerCase()} provider attempts: ${lastClassified.sanitizedReason}`
            : 'Gemini attempt budget exhausted before dispatch';
          return this.buildDegradedResult(
            event.correlationId,
            {
              kind: 'TERMINAL',
              isRetriable: false,
              status: 'UNAVAILABLE',
              sanitizedReason: exhaustedReason,
            },
            evaluatedAt,
          );
        }

        lastClassified = classifyProviderError(err);

        if (!lastClassified.isRetriable || attempt >= this.retryPolicy.maxRetries) {
          return this.buildDegradedResult(event.correlationId, lastClassified, evaluatedAt);
        }

        const delay = this.retryPolicy.calculateDelay(attempt);
        if (delay >= deadlineAt - Date.now()) {
          return this.buildDegradedResult(event.correlationId, lastClassified, evaluatedAt);
        }

        // eslint-disable-next-line no-await-in-loop
        await this.retryPolicy.sleep(delay, operationSignal);
      } finally {
        clearTimeout(attemptTimerId);
        operationSignal.removeEventListener('abort', abortAttempt);
        if (limiterSignal && limiterSignal !== operationSignal) {
          limiterSignal.removeEventListener('abort', abortAttempt);
        }
      }
    }

    return this.buildDegradedResult(
      event.correlationId,
      lastClassified ?? {
        kind: 'TERMINAL',
        isRetriable: false,
        status: 'UNAVAILABLE',
        sanitizedReason: 'Retry attempts exhausted without successful response',
      },
      evaluatedAt,
    );
  }

  private buildDegradedResult(
    correlationId: string,
    classified: ClassifiedProviderError,
    evaluatedAt: string,
  ): DegradedModelResult {
    return DegradedModelResultSchema.parse({
      correlationId,
      status: classified.status,
      reason: classified.sanitizedReason,
      provenance: 'UNAVAILABLE',
      evaluatedAt,
    });
  }
}
