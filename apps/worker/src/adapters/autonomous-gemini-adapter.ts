import { GoogleGenAI } from '@google/genai';
import {
  type IntrusionEventEnvelope,
  type AutonomousModelAnalysisResult,
  type AutonomousDegradedModelResult,
  AutonomousModelAnalysisResultSchema,
  AutonomousDegradedModelResultSchema,
  AutonomousToolCallSchema,
} from '@false-route/contracts';
import { classifyProviderError, type ClassifiedProviderError } from './error-classifier.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { GEMINI_TOOL_DECLARATIONS } from '../tools/tool-declarations.js';

export interface AutonomousGeminiAdapterOptions {
  readonly apiKey: string;
  readonly modelName: string;
  readonly requestTimeoutMs?: number;
  readonly operationDeadlineMs?: number;
  readonly maxRetries?: number;
  readonly maxConcurrency?: number;
  readonly maxQueueSize?: number;
}

export interface AutonomousGeminiAdapter {
  analyzeEnvelope(
    envelope: IntrusionEventEnvelope,
    parentSignal?: AbortSignal,
  ): Promise<AutonomousModelAnalysisResult | AutonomousDegradedModelResult>;
}

const AUTONOMOUS_SYSTEM_INSTRUCTION = `You are a cybersecurity deception analysis assistant evaluating a synthetic intrusion event.
Analyze the intrusion scenario and request appropriate containment, deception, alert, or response plan tools from the provided tool catalog.
You must submit exactly one recommend_response_plan tool request providing your overall analysis confidence (0.0 to 1.0) and recommended response actions, followed by any specific action tool requests.
You may only request tools from the declared function catalog. Do not execute or request arbitrary commands.`;

export class LiveAutonomousGeminiAdapter implements AutonomousGeminiAdapter {
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly requestTimeoutMs: number;
  private readonly operationDeadlineMs: number;
  private readonly limiter: ConcurrencyLimiter;

  constructor(options: AutonomousGeminiAdapterOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.modelName = options.modelName;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    this.operationDeadlineMs = options.operationDeadlineMs ?? 8000;
    this.limiter = new ConcurrencyLimiter({
      maxConcurrency: options.maxConcurrency ?? 2,
      maxQueueSize: options.maxQueueSize ?? 0,
    });
  }

  async analyzeEnvelope(
    envelope: IntrusionEventEnvelope,
    parentSignal?: AbortSignal,
  ): Promise<AutonomousModelAnalysisResult | AutonomousDegradedModelResult> {
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
        return this.executeSingleCall(
          envelope,
          evaluatedAt,
          deadlineAt,
          operationController.signal,
          limiterSignal,
        );
      }, operationController.signal);
    } catch (err) {
      const classified = classifyProviderError(err);
      return this.buildDegradedResult(envelope.correlationId, classified, evaluatedAt);
    } finally {
      clearTimeout(operationTimeoutId);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  private async executeSingleCall(
    envelope: IntrusionEventEnvelope,
    evaluatedAt: string,
    deadlineAt: number,
    operationSignal: AbortSignal,
    limiterSignal?: AbortSignal,
  ): Promise<AutonomousModelAnalysisResult | AutonomousDegradedModelResult> {
    const minimizedInput = {
      scenarioKind: envelope.scenarioKind,
      sourceIp: envelope.sourceIp,
      evidence: envelope.evidence,
    };

    const remainingOperationMs = deadlineAt - Date.now();
    if (remainingOperationMs <= 0 || operationSignal.aborted) {
      const timeoutClassification: ClassifiedProviderError = {
        kind: 'TIMEOUT',
        isRetriable: false,
        status: 'TIMEOUT',
        sanitizedReason: `Gemini complete operation deadline exceeded after ${this.operationDeadlineMs}ms`,
      };
      return this.buildDegradedResult(envelope.correlationId, timeoutClassification, evaluatedAt);
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
          systemInstruction: AUTONOMOUS_SYSTEM_INSTRUCTION,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ functionDeclarations: GEMINI_TOOL_DECLARATIONS as any }],
          maxOutputTokens: 1024,
          temperature: 0,
        },
      });

      const response = await Promise.race([responsePromise, abortPromise]);
      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length > 5) {
        return this.buildDegradedResult(
          envelope.correlationId,
          {
            kind: 'SCHEMA_INVALID',
            isRetriable: false,
            status: 'INVALID_OUTPUT',
            sanitizedReason: 'Model exceeded maximum allowed tool requests count (5)',
          },
          evaluatedAt,
        );
      }

      const parsedToolRequests = [];

      for (const fc of functionCalls) {
        const rawCall = {
          toolCallId: `model-call-${Date.now().toString(36)}-${parsedToolRequests.length + 1}`,
          toolName: fc.name,
          parameters: (fc.args ?? {}) as Record<string, unknown>,
          requestedAt: evaluatedAt,
        };
        const parseResult = AutonomousToolCallSchema.safeParse(rawCall);
        if (!parseResult.success) {
          return this.buildDegradedResult(
            envelope.correlationId,
            {
              kind: 'SCHEMA_INVALID',
              isRetriable: false,
              status: 'INVALID_OUTPUT',
              sanitizedReason: 'Model returned schema-invalid tool request parameters',
            },
            evaluatedAt,
          );
        }
        parsedToolRequests.push(parseResult.data);
      }

      // Validate structured confidence from recommend_response_plan
      const planCalls = parsedToolRequests.filter((r) => r.toolName === 'recommend_response_plan');
      if (planCalls.length !== 1) {
        return this.buildDegradedResult(
          envelope.correlationId,
          {
            kind: 'SCHEMA_INVALID',
            isRetriable: false,
            status: 'INVALID_OUTPUT',
            sanitizedReason:
              'Model must provide exactly one recommend_response_plan request with structured confidence',
          },
          evaluatedAt,
        );
      }

      const confidenceVal = planCalls[0]!.parameters['confidence'];
      if (
        typeof confidenceVal !== 'number' ||
        Number.isNaN(confidenceVal) ||
        confidenceVal < 0 ||
        confidenceVal > 1
      ) {
        return this.buildDegradedResult(
          envelope.correlationId,
          {
            kind: 'SCHEMA_INVALID',
            isRetriable: false,
            status: 'INVALID_OUTPUT',
            sanitizedReason: 'Model provided invalid confidence score',
          },
          evaluatedAt,
        );
      }

      // Bounded, application-owned summary (never use raw response.text or model explanations)
      const applicationSummary = `Gemini returned ${parsedToolRequests.length} validated bounded tool requests for ${envelope.scenarioKind}`;

      return AutonomousModelAnalysisResultSchema.parse({
        status: 'SUCCESS',
        correlationId: envelope.correlationId,
        modelIdentifier: this.modelName,
        evaluatedAt,
        confidence: confidenceVal,
        summary: applicationSummary,
        toolRequests: parsedToolRequests,
        provenance: 'INFERRED',
      });
    } catch (err) {
      const classified = classifyProviderError(err);
      return this.buildDegradedResult(envelope.correlationId, classified, evaluatedAt);
    } finally {
      clearTimeout(attemptTimerId);
      operationSignal.removeEventListener('abort', abortAttempt);
      if (limiterSignal && limiterSignal !== operationSignal) {
        limiterSignal.removeEventListener('abort', abortAttempt);
      }
    }
  }

  private buildDegradedResult(
    correlationId: string,
    classified: ClassifiedProviderError,
    evaluatedAt: string,
  ): AutonomousDegradedModelResult {
    return AutonomousDegradedModelResultSchema.parse({
      status: classified.status,
      correlationId,
      modelIdentifier: this.modelName,
      evaluatedAt,
      reason: classified.sanitizedReason,
      provenance: 'UNAVAILABLE',
    });
  }
}
