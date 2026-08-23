import { randomUUID } from 'node:crypto';
import { BUDGET_LIMITS, type GeminiUsageMetadata } from '@false-route/contracts';
import { type BudgetRepository } from '@false-route/database';

export interface GeminiBudgetServiceOptions {
  readonly budgetRepo: BudgetRepository;
  readonly maxInputTokensPerEvent?: number;
  readonly dailyTokenLimit?: number;
  readonly maxCallsPerEvent?: number;
  readonly clock?: () => Date;
}

/** Durable authorization for exactly one real provider dispatch. */
export interface GeminiAttempt {
  readonly attemptNumber: number;
  readonly claimToken: string;
}

/**
 * Handed to `execute` so a provider adapter that retries internally can obtain durable
 * authorization for every dispatch it makes. Without this, one reservation would silently cover
 * an adapter's whole retry loop and the per-event provider-call ceiling would not be enforced.
 */
export interface GeminiAttemptGate {
  /**
   * Authorizes one provider dispatch and writes the durable DISPATCHED marker, so it must be the
   * last statement before the request is sent. Rejects — before any provider invocation — once the
   * durable per-event attempt ceiling is reached. Settles the previous attempt at its full reserved
   * amount, because an attempt left unsettled failed ambiguously and its spend must be retained.
   */
  beginAttempt(): Promise<GeminiAttempt>;
}

export interface ExecuteWithBudgetParams<T> {
  /**
   * Optional caller assertion about which attempt this is. It is validated strictly but never
   * trusted: the durable attempt number is derived by the repository inside the advisory-locked
   * transaction that enforces the ceiling.
   */
  readonly attemptNumber?: number;
  readonly eventId: string;
  readonly execute: (gate: GeminiAttemptGate) => Promise<T>;
  readonly extractUsageMetadata?: (result: T) => GeminiUsageMetadata | null | undefined;
  readonly isPreCallError?: (error: unknown) => boolean;
}

interface OpenAttempt {
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly amountReserved: number;
  readonly version: number;
}

interface AttemptGateConfig {
  readonly budgetRepo: BudgetRepository;
  readonly eventId: string;
  readonly windowKey: string;
  readonly amountPerAttempt: number;
  readonly dailyTokenLimit: number;
  readonly maxCallsPerEvent: number;
}

function clampTokens(usage: GeminiUsageMetadata | null | undefined, maxTokens: number): number {
  if (
    !usage ||
    typeof usage.promptTokenCount !== 'number' ||
    !Number.isFinite(usage.promptTokenCount) ||
    usage.promptTokenCount <= 0
  ) {
    return maxTokens;
  }

  const candidateTokens =
    typeof usage.candidatesTokenCount === 'number' && Number.isFinite(usage.candidatesTokenCount)
      ? usage.candidatesTokenCount
      : 0;

  return Math.min(usage.promptTokenCount + candidateTokens, maxTokens);
}

class DurableAttemptGate implements GeminiAttemptGate {
  private readonly config: AttemptGateConfig;
  private open: OpenAttempt | null = null;
  private primed: GeminiAttempt | null = null;

  constructor(config: AttemptGateConfig) {
    this.config = config;
  }

  /**
   * Pre-authorizes the first dispatch so the ceiling fails closed before `execute` runs at all.
   * A gate-aware callee receives this same attempt from its first `beginAttempt()` call.
   */
  async prime(): Promise<void> {
    this.primed = await this.acquire();
  }

  async beginAttempt(): Promise<GeminiAttempt> {
    if (this.primed) {
      const preAcquired = this.primed;
      this.primed = null;
      return preAcquired;
    }

    await this.settle(undefined);
    return this.acquire();
  }

  /** Settles the open attempt; `usage` absent means charge the full reservation. */
  async settle(usage: GeminiUsageMetadata | null | undefined): Promise<void> {
    const attempt = this.open;
    if (!attempt) {
      return;
    }
    this.open = null;
    this.primed = null;

    try {
      await this.config.budgetRepo.consumeBudget({
        idempotencyKey: attempt.idempotencyKey,
        ownerId: attempt.ownerId,
        amountConsumed: clampTokens(usage, attempt.amountReserved),
        expectedVersion: attempt.version,
      });
    } catch {
      // Incurred spend stays reserved when settlement cannot be persisted; releasing it here would
      // hand back budget for a call the provider already served.
    }
  }

  /** Only for a failure verified to have happened before the request was dispatched. */
  async releaseVerifiedPreCall(): Promise<void> {
    const attempt = this.open;
    if (!attempt) {
      return;
    }
    this.open = null;
    this.primed = null;

    // Recorded before the release so a crash in between still reconciles the row as EXPIRED
    // rather than as conservatively spent.
    await this.config.budgetRepo.recordGeminiAttemptOutcome({
      idempotencyKey: attempt.idempotencyKey,
      ownerId: attempt.ownerId,
      outcome: 'PRE_CALL_FAILED',
      expectedVersion: attempt.version,
    });

    await this.config.budgetRepo
      .releaseBudget({
        idempotencyKey: attempt.idempotencyKey,
        ownerId: attempt.ownerId,
        expectedVersion: attempt.version,
      })
      .catch(() => {});
  }

  private async acquire(): Promise<GeminiAttempt> {
    const ownerId = randomUUID();
    const outcome = await this.config.budgetRepo.acquireEventAttemptSlot({
      eventId: this.config.eventId,
      category: 'DAILY_GEMINI_TOKENS',
      windowKey: this.config.windowKey,
      amountReserved: this.config.amountPerAttempt,
      limit: this.config.dailyTokenLimit,
      ownerId,
      maxAttempts: this.config.maxCallsPerEvent,
      idempotencyKeyPrefix: `gemini-tokens:${this.config.eventId}`,
      ttlMs: 60_000,
    });

    if (!outcome.granted) {
      throw new Error(`Gemini durable token budget ceiling exceeded: ${outcome.reason}`);
    }

    this.open = {
      attemptNumber: outcome.attemptNumber,
      idempotencyKey: outcome.reservation.idempotencyKey,
      ownerId: outcome.reservation.ownerId,
      amountReserved: outcome.reservation.amountReserved,
      version: outcome.reservation.version,
    };

    // Throwing here leaves the reservation without evidence, which reconciliation treats as spent.
    // That is the required direction: the caller must not dispatch when the marker is unwritten.
    await this.config.budgetRepo.recordGeminiAttemptOutcome({
      idempotencyKey: outcome.reservation.idempotencyKey,
      ownerId: outcome.reservation.ownerId,
      outcome: 'DISPATCHED',
      expectedVersion: outcome.reservation.version,
    });

    return { attemptNumber: outcome.attemptNumber, claimToken: outcome.reservation.ownerId };
  }
}

export class GeminiBudgetService {
  private readonly budgetRepo: BudgetRepository;
  private readonly maxInputTokensPerEvent: number;
  private readonly dailyTokenLimit: number;
  private readonly maxCallsPerEvent: number;
  private readonly clock: () => Date;

  constructor(options: GeminiBudgetServiceOptions) {
    this.budgetRepo = options.budgetRepo;
    this.maxInputTokensPerEvent =
      options.maxInputTokensPerEvent ?? BUDGET_LIMITS.MAX_GEMINI_INPUT_TOKENS_PER_EVENT;
    this.dailyTokenLimit = options.dailyTokenLimit ?? BUDGET_LIMITS.DAILY_GEMINI_TOKENS;
    this.maxCallsPerEvent = options.maxCallsPerEvent ?? BUDGET_LIMITS.MAX_GEMINI_CALLS_PER_EVENT;
    this.clock = options.clock ?? (() => new Date());
  }

  async executeWithBudget<T>(params: ExecuteWithBudgetParams<T>): Promise<T> {
    const { eventId, attemptNumber, execute, extractUsageMetadata, isPreCallError } = params;

    if (attemptNumber !== undefined) {
      if (
        typeof attemptNumber !== 'number' ||
        !Number.isInteger(attemptNumber) ||
        attemptNumber < 1 ||
        attemptNumber > this.maxCallsPerEvent
      ) {
        throw new Error(
          `Invalid Gemini attemptNumber: ${attemptNumber} must be an integer between 1 and ${this.maxCallsPerEvent}`,
        );
      }
    }

    const gate = new DurableAttemptGate({
      budgetRepo: this.budgetRepo,
      eventId,
      windowKey: this.clock().toISOString().slice(0, 10),
      amountPerAttempt: this.maxInputTokensPerEvent,
      dailyTokenLimit: this.dailyTokenLimit,
      maxCallsPerEvent: this.maxCallsPerEvent,
    });

    await gate.prime();

    let providerResult: T;
    try {
      providerResult = await execute(gate);
    } catch (err) {
      if (isPreCallError?.(err) === true) {
        await gate.releaseVerifiedPreCall();
      }
      // Ambiguous or provider-side failures keep the reservation as incurred spend.
      throw err;
    }

    await gate.settle(extractUsageMetadata ? extractUsageMetadata(providerResult) : null);
    return providerResult;
  }
}
