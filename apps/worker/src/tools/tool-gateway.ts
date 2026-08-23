import { randomUUID } from 'node:crypto';
import { type ToolCall, type ToolResult, BUDGET_LIMITS } from '@false-route/contracts';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  FakeCloudRunAdapter,
  FakeFalseRouteAdapter,
  FakeCloudArmorAdapter,
} from './fake-cloud-adapters.js';
import {
  type ToolExecutionContext,
  evaluateToolPolicy,
  validateToolParameters,
  estimateSpendUsd,
  resolveProviderName,
} from './tool-policy.js';
import {
  dispatchProviderCall,
  inspectProviderResource,
  ensureLeasePersisted,
  handleExistingReservation,
  ambiguousToolResult,
  rejectToolCall,
  failToolCall,
  releaseToolBudgets,
} from './tool-execution-helper.js';

export { type ToolExecutionContext };

export interface ToolGatewayOptions {
  readonly cloudRunAdapter?: FakeCloudRunAdapter;
  readonly falseRouteAdapter?: FakeFalseRouteAdapter;
  readonly cloudArmorAdapter?: FakeCloudArmorAdapter;
  readonly maxHourlyToolCeiling?: number;
  readonly dailySpendLimitUsd?: number;
  readonly workerId?: string;
  readonly clock?: () => Date;
}

interface BudgetHandles {
  readonly toolKey: string;
  readonly usdKey: string;
  readonly estimatedCost: number;
}

interface ExecutionEffect {
  readonly providerResourceId?: string | undefined;
  readonly details: Record<string, unknown>;
}

/**
 * How this attempt is authorised to move the durable provider intent to EXECUTED.
 *
 * `CLAIM_TOKEN` presents the token this process actually obtained. `RECONCILE` takes over an
 * abandoned intent and must satisfy the repository's version/owner/expiry fence. `ALREADY_EXECUTED`
 * means the intent is durably settled and boundary 1 has nothing left to do.
 */
type IntentSettlement =
  | { readonly kind: 'CLAIM_TOKEN'; readonly claimToken: string }
  | { readonly kind: 'ALREADY_EXECUTED' }
  | {
      readonly kind: 'RECONCILE';
      readonly expectedStatus: 'PENDING' | 'CLAIMED';
      readonly expectedVersion: number;
      readonly expectedOwner?: string | undefined;
    };

const ACTIVE_CLAIM_REASON = 'Active provider intent claim is currently held by another worker';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export class ToolGateway {
  private readonly cloudRun: FakeCloudRunAdapter;
  private readonly falseRoute: FakeFalseRouteAdapter;
  private readonly cloudArmor: FakeCloudArmorAdapter;
  private readonly maxHourlyCeiling: number;
  private readonly dailySpendLimitUsd: number;
  private hourlyExecutionCount = 0;
  private lastCeilingReset = Date.now();
  private readonly workerId: string;
  private readonly clock: () => Date;
  /** Claim tokens this process actually obtained, so a retry can repair without taking over. */
  private readonly heldClaimTokens = new Map<string, string>();
  /** Operations currently executing in this process; a shared worker id is not a claim. */
  private readonly inFlightKeys = new Set<string>();

  constructor(
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly activityRepo: ActivityEventRepository,
    options: ToolGatewayOptions = {},
  ) {
    this.cloudRun = options.cloudRunAdapter ?? new FakeCloudRunAdapter();
    this.falseRoute = options.falseRouteAdapter ?? new FakeFalseRouteAdapter();
    this.cloudArmor = options.cloudArmorAdapter ?? new FakeCloudArmorAdapter();
    this.maxHourlyCeiling = options.maxHourlyToolCeiling ?? BUDGET_LIMITS.HOURLY_TOOL_OPERATIONS;
    this.dailySpendLimitUsd = options.dailySpendLimitUsd ?? BUDGET_LIMITS.DAILY_USD;
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.clock = options.clock ?? (() => new Date());
  }

  async executeToolCall(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const idempotencyKey = `idem-${toolCall.toolName}-${context.eventId}`;

    // Two concurrent requests in one process share `workerId`; that is not evidence of ownership,
    // so the duplicate is refused instead of being allowed to take over the live claim.
    if (this.inFlightKeys.has(idempotencyKey)) {
      return ambiguousToolResult(toolCall, idempotencyKey, ACTIVE_CLAIM_REASON, {
        error: 'ACTIVE_CLAIM_HELD',
      });
    }
    this.inFlightKeys.add(idempotencyKey);
    try {
      return await this.runToolCall(toolCall, context, idempotencyKey);
    } finally {
      this.inFlightKeys.delete(idempotencyKey);
    }
  }

  private async runToolCall(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    idempotencyKey: string,
  ): Promise<ToolResult> {
    const input = toolCall.parameters;

    this.checkAndResetHourlyCeiling();
    if (this.hourlyExecutionCount >= this.maxHourlyCeiling) {
      return this.reject(
        toolCall,
        context,
        idempotencyKey,
        input,
        `Hourly safety spend ceiling reached (${this.maxHourlyCeiling} operations/hour)`,
      );
    }

    const validation = validateToolParameters(toolCall, context);
    if (!validation.success) {
      return this.reject(toolCall, context, idempotencyKey, input, validation.error!);
    }

    const policyDecision = evaluateToolPolicy(toolCall.toolName, context);
    if (!policyDecision.authorized) {
      return this.reject(toolCall, context, idempotencyKey, input, policyDecision.reason);
    }

    const reservation = await this.workflowRepo.reserveToolOperation({
      idempotencyKey,
      eventId: context.eventId,
      toolName: toolCall.toolName,
      input,
      authorized: true,
      policyReason: policyDecision.reason,
      initialStage: 'AUTHORIZED',
    });

    if (
      reservation.isExisting &&
      (reservation.operation.stage === 'FAKE_EXECUTED' ||
        reservation.operation.stage === 'REJECTED')
    ) {
      return handleExistingReservation(
        reservation.operation,
        toolCall,
        context,
        idempotencyKey,
        this.activityRepo,
      );
    }

    const now = this.clock();
    const estimatedCost = estimateSpendUsd(toolCall.toolName);
    const budget: BudgetHandles = {
      toolKey: `budget:tool:${idempotencyKey}`,
      usdKey: `budget:usd:${idempotencyKey}`,
      estimatedCost,
    };

    // Recovery pre-pass. A restarted worker owns no live reservation, so budget reservation would
    // fail closed and make this unreachable; the durable ledger and provider state are therefore
    // inspected first, before any new reservation is attempted.
    if (reservation.isExisting) {
      const recovered = await this.recoverAmbiguousOperation(
        toolCall,
        context,
        idempotencyKey,
        budget,
      );
      if (recovered) return recovered;
    }

    const toolReservation = await this.workflowRepo.reserveBudget({
      idempotencyKey: budget.toolKey,
      category: 'HOURLY_TOOL_OPERATIONS',
      windowKey: now.toISOString().slice(0, 13),
      amountReserved: 1,
      limit: this.maxHourlyCeiling,
      ownerId: this.workerId,
      eventId: context.eventId,
    });
    if (!toolReservation.granted) {
      return this.reject(toolCall, context, idempotencyKey, input, toolReservation.reason);
    }

    if (estimatedCost > 0) {
      const usdReservation = await this.workflowRepo.reserveBudget({
        idempotencyKey: budget.usdKey,
        category: 'DAILY_USD',
        windowKey: now.toISOString().slice(0, 10),
        amountReserved: estimatedCost,
        limit: this.dailySpendLimitUsd,
        ownerId: this.workerId,
        eventId: context.eventId,
      });
      if (!usdReservation.granted) {
        await releaseToolBudgets(
          budget.toolKey,
          budget.usdKey,
          0,
          this.workerId,
          this.workflowRepo,
        );
        return this.reject(toolCall, context, idempotencyKey, input, usdReservation.reason);
      }
    }

    const intentClaim = await this.workflowRepo.claimProviderIntent({
      idempotencyKey,
      eventId: context.eventId,
      operationType: toolCall.toolName,
      provider: resolveProviderName(toolCall.toolName),
      claimOwner: this.workerId,
      payload: toolCall.parameters,
    });

    if (intentClaim.disposition === 'ALREADY_EXECUTED') {
      const priorResult = asRecord(intentClaim.intent.result);
      const priorResourceId =
        typeof priorResult['providerResourceId'] === 'string'
          ? priorResult['providerResourceId']
          : undefined;
      return this.settleExecution({
        toolCall,
        context,
        idempotencyKey,
        budget,
        settlement: { kind: 'ALREADY_EXECUTED' },
        effect: { providerResourceId: priorResourceId, details: priorResult },
        successReason: 'Recovered the durable result without repeating the provider call',
        countsTowardsCeiling: false,
      });
    }

    if (intentClaim.disposition === 'RECONCILIATION_REQUIRED' || !intentClaim.claimToken) {
      return this.reconcileUnclaimedIntent(toolCall, context, idempotencyKey, budget, intentClaim);
    }

    const claimToken = intentClaim.claimToken;
    this.heldClaimTokens.set(idempotencyKey, claimToken);

    let effect: ExecutionEffect;
    try {
      effect = await dispatchProviderCall(
        toolCall,
        idempotencyKey,
        this.cloudRun,
        this.falseRoute,
        this.cloudArmor,
      );
    } catch {
      const sanitizedReason = 'Simulated adapter execution failure';
      await this.workflowRepo.updateProviderIntentStatus({
        idempotencyKey,
        claimToken,
        status: 'FAILED',
        result: { error: sanitizedReason, failureCategory: 'ADAPTER_EXECUTION_FAILURE' },
      });
      this.heldClaimTokens.delete(idempotencyKey);
      await releaseToolBudgets(
        budget.toolKey,
        budget.usdKey,
        estimatedCost,
        this.workerId,
        this.workflowRepo,
      );
      return failToolCall(
        toolCall,
        context,
        idempotencyKey,
        sanitizedReason,
        this.workflowRepo,
        this.activityRepo,
      );
    }

    // Provider call succeeded. From here the intent is never marked FAILED and budget is never
    // released; every remaining boundary is a projection that a retry may repair.
    return this.settleExecution({
      toolCall,
      context,
      idempotencyKey,
      budget,
      settlement: { kind: 'CLAIM_TOKEN', claimToken },
      effect,
      successReason: policyDecision.reason,
      countsTowardsCeiling: true,
    });
  }

  /**
   * Inspects the durable ledger and deterministic provider state for an operation that already has
   * a non-terminal ledger row, and settles it without repeating the provider mutation.
   *
   * Returns `null` only when nothing durable happened yet and a fresh attempt is safe.
   */
  private async recoverAmbiguousOperation(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    idempotencyKey: string,
    budget: BudgetHandles,
  ): Promise<ToolResult | null> {
    const intent = await this.workflowRepo.getProviderIntent(idempotencyKey);
    if (!intent) return null;

    const observed = inspectProviderResource(
      toolCall,
      idempotencyKey,
      this.cloudRun,
      this.falseRoute,
      this.cloudArmor,
    );

    if (intent.status === 'EXECUTED') {
      const priorResult = asRecord(intent.result);
      const priorResourceId =
        typeof priorResult['providerResourceId'] === 'string'
          ? priorResult['providerResourceId']
          : observed?.resourceId;
      return this.settleExecution({
        toolCall,
        context,
        idempotencyKey,
        budget,
        settlement: { kind: 'ALREADY_EXECUTED' },
        effect: { providerResourceId: priorResourceId, details: priorResult },
        successReason: 'Recovered the durable result without repeating the provider call',
        countsTowardsCeiling: false,
      });
    }

    const claimActive =
      intent.status === 'CLAIMED' &&
      intent.claimExpiresAt !== null &&
      intent.claimExpiresAt > this.clock();

    if (observed && (intent.status === 'PENDING' || intent.status === 'CLAIMED')) {
      const settlement = this.resolveRecoverySettlement(idempotencyKey, intent, claimActive);
      if (!settlement) {
        return ambiguousToolResult(toolCall, idempotencyKey, ACTIVE_CLAIM_REASON, {
          error: 'ACTIVE_CLAIM_HELD',
        });
      }
      return this.settleExecution({
        toolCall,
        context,
        idempotencyKey,
        budget,
        settlement,
        effect: { providerResourceId: observed.resourceId, details: { ...observed.details } },
        successReason: 'Reconciled and recovered provider resource without repeating mutation',
        countsTowardsCeiling: false,
      });
    }

    if (intent.status === 'FAILED') {
      if (observed) {
        return ambiguousToolResult(
          toolCall,
          idempotencyKey,
          'Provider effect exists but the durable intent records failure; explicit reconciliation required',
          { error: 'PROVIDER_EFFECT_CONTRADICTS_FAILED_INTENT' },
          observed.resourceId,
        );
      }
      // Verified pre-call failure with no provider effect: the retained reservation may be freed.
      await this.releaseAmbiguousBudget(idempotencyKey, budget);
      return failToolCall(
        toolCall,
        context,
        idempotencyKey,
        'RECONCILIATION_REQUIRED',
        this.workflowRepo,
        this.activityRepo,
      );
    }

    if (claimActive) {
      return ambiguousToolResult(toolCall, idempotencyKey, ACTIVE_CLAIM_REASON, {
        error: 'ACTIVE_CLAIM_HELD',
      });
    }

    // Outcome unknown: no provider effect observed, but a prior attempt may still be in flight.
    // Retain the conservative committed spend rather than converting this into a terminal reject.
    const held = await this.workflowRepo.getToolBudgetReservation(budget.toolKey);
    if (held && held.status === 'RESERVED' && held.ownerId !== this.workerId) {
      return ambiguousToolResult(
        toolCall,
        idempotencyKey,
        'Ambiguous prior attempt still holds a durable budget reservation; reconciliation required',
        { error: 'AMBIGUOUS_RESERVATION_HELD' },
      );
    }
    return null;
  }

  private resolveRecoverySettlement(
    idempotencyKey: string,
    intent: { status: string; version: number; claimOwner: string | null },
    claimActive: boolean,
  ): IntentSettlement | null {
    const heldToken = this.heldClaimTokens.get(idempotencyKey);
    if (heldToken && intent.status === 'CLAIMED') {
      return { kind: 'CLAIM_TOKEN', claimToken: heldToken };
    }
    if (claimActive) return null;
    return {
      kind: 'RECONCILE',
      expectedStatus: intent.status === 'CLAIMED' ? 'CLAIMED' : 'PENDING',
      expectedVersion: intent.version,
      ...(intent.claimOwner !== null && { expectedOwner: intent.claimOwner }),
    };
  }

  private async reconcileUnclaimedIntent(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    idempotencyKey: string,
    budget: BudgetHandles,
    intentClaim: { intent: Record<string, unknown> },
  ): Promise<ToolResult> {
    const intent = intentClaim.intent as unknown as {
      status?: string;
      claimOwner?: string | null;
      claimExpiresAt?: Date | null;
      version?: number;
    };

    const claimActive =
      intent?.status === 'CLAIMED' &&
      !!intent.claimExpiresAt &&
      new Date(intent.claimExpiresAt) > this.clock();

    const observed = inspectProviderResource(
      toolCall,
      idempotencyKey,
      this.cloudRun,
      this.falseRoute,
      this.cloudArmor,
    );

    if (observed) {
      const settlement = this.resolveRecoverySettlement(
        idempotencyKey,
        {
          status: intent?.status ?? 'PENDING',
          version: intent?.version ?? 0,
          claimOwner: intent?.claimOwner ?? null,
        },
        claimActive,
      );
      if (!settlement) {
        return ambiguousToolResult(toolCall, idempotencyKey, ACTIVE_CLAIM_REASON, {
          error: 'ACTIVE_CLAIM_HELD',
        });
      }
      return this.settleExecution({
        toolCall,
        context,
        idempotencyKey,
        budget,
        settlement,
        effect: { providerResourceId: observed.resourceId, details: { ...observed.details } },
        successReason: 'Reconciled and recovered provider resource without repeating mutation',
        countsTowardsCeiling: false,
      });
    }

    if (claimActive) {
      return ambiguousToolResult(toolCall, idempotencyKey, ACTIVE_CLAIM_REASON, {
        error: 'ACTIVE_CLAIM_HELD',
      });
    }

    await releaseToolBudgets(
      budget.toolKey,
      budget.usdKey,
      budget.estimatedCost,
      this.workerId,
      this.workflowRepo,
    );
    return failToolCall(
      toolCall,
      context,
      idempotencyKey,
      'RECONCILIATION_REQUIRED',
      this.workflowRepo,
      this.activityRepo,
    );
  }

  /**
   * Writes the five durable boundaries of a successful (or already-successful) provider effect:
   * provider intent, lease, budget settlement, activity projection, and finally the tool ledger.
   *
   * The ledger is written last and only when every mandatory projection above it is durable, so a
   * terminal `FAKE_EXECUTED` row can never coexist with a missing projection. Any earlier failure
   * retains committed spend and leaves the operation non-terminal and repairable.
   */
  private async settleExecution(args: {
    toolCall: ToolCall;
    context: ToolExecutionContext;
    idempotencyKey: string;
    budget: BudgetHandles;
    settlement: IntentSettlement;
    effect: ExecutionEffect;
    successReason: string;
    countsTowardsCeiling: boolean;
  }): Promise<ToolResult> {
    const { toolCall, context, idempotencyKey, budget, effect } = args;
    let failure: string | null = null;

    // Boundary 1: durable provider intent.
    if (args.settlement.kind !== 'ALREADY_EXECUTED') {
      try {
        await this.workflowRepo.updateProviderIntentStatus({
          idempotencyKey,
          ...this.intentFence(args.settlement),
          status: 'EXECUTED',
          result: {
            ...effect.details,
            ...(effect.providerResourceId && { providerResourceId: effect.providerResourceId }),
          },
        });
        this.heldClaimTokens.delete(idempotencyKey);
      } catch (error) {
        failure = `Provider intent status update failed: ${describeError(error)}`;
      }
    }

    // Boundary 2: lease projection.
    try {
      await ensureLeasePersisted(
        toolCall,
        this.workflowRepo,
        effect.providerResourceId,
        effect.details,
      );
    } catch (error) {
      failure ??= `Lease persistence failed: ${describeError(error)}`;
    }

    // Boundary 3: budget settlement.
    try {
      await this.settleBudget(idempotencyKey, budget);
      if (args.countsTowardsCeiling) this.hourlyExecutionCount += 1;
    } catch (error) {
      failure ??= `Budget consumption failed: ${describeError(error)}`;
    }

    // Boundary 4: activity projection. Activity is required evidence, not a best-effort log.
    try {
      await this.activityRepo.recordActivityEvent({
        eventId: context.eventId,
        correlationId: context.correlationId,
        stage: failure ? 'FAILED' : 'FAKE_EXECUTED',
        eventType: failure ? 'TOOL_FAILED' : 'TOOL_EXECUTED',
        summary: failure
          ? `Simulated action executed but persistence failed: ${failure}`
          : `Simulated action executed for ${toolCall.toolName}`,
        provenance: 'DERIVED',
        payload: {
          ...effect.details,
          ...(failure && { error: failure, reconciliationRequired: true }),
        },
      });
    } catch (error) {
      failure ??= `Activity event logging failed: ${describeError(error)}`;
    }

    // Boundary 5: tool ledger. Terminal only once boundaries 1-4 are durable.
    if (failure) {
      await this.workflowRepo
        .updateToolOperationStage({
          idempotencyKey,
          stage: 'FAILED',
          observedState: 'UNKNOWN',
          expectedPriorStage: ['AUTHORIZED', 'FAILED'],
          ...(effect.providerResourceId !== undefined && {
            providerResourceId: effect.providerResourceId,
          }),
          details: { ...effect.details, error: failure, reconciliationRequired: true },
        })
        .catch(() => {});
      return this.ambiguous(toolCall, idempotencyKey, failure, effect);
    }

    try {
      await this.workflowRepo.updateToolOperationStage({
        idempotencyKey,
        stage: 'FAKE_EXECUTED',
        observedState: 'READY',
        expectedPriorStage: ['AUTHORIZED', 'FAILED'],
        ...(effect.providerResourceId !== undefined && {
          providerResourceId: effect.providerResourceId,
        }),
        details: effect.details,
      });
    } catch (error) {
      // The ledger stays non-terminal, so a retry repairs it without a second provider mutation.
      return this.ambiguous(
        toolCall,
        idempotencyKey,
        `Tool ledger stage update failed: ${describeError(error)}`,
        effect,
      );
    }

    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      stage: 'FAKE_EXECUTED',
      idempotencyKey,
      authorized: true,
      policyReason: args.successReason,
      providerResourceId: effect.providerResourceId,
      details: effect.details,
      executedAt: new Date().toISOString(),
    };
  }

  private intentFence(settlement: IntentSettlement) {
    if (settlement.kind === 'CLAIM_TOKEN') {
      return { claimToken: settlement.claimToken } as const;
    }
    const reconcile = settlement as Extract<IntentSettlement, { kind: 'RECONCILE' }>;
    return {
      reconciliationClaim: {
        expectedStatus: reconcile.expectedStatus,
        expectedVersion: reconcile.expectedVersion,
        ...(reconcile.expectedOwner !== undefined && { expectedOwner: reconcile.expectedOwner }),
        // Taking over a CLAIMED intent without its token always requires an expired claim.
        requireExpired: reconcile.expectedStatus === 'CLAIMED',
        asOf: this.clock(),
      },
    } as const;
  }

  private ambiguous(
    toolCall: ToolCall,
    idempotencyKey: string,
    failure: string,
    effect: ExecutionEffect,
  ): ToolResult {
    return ambiguousToolResult(
      toolCall,
      idempotencyKey,
      `Ambiguous outcome: provider call succeeded but persistence failed (${failure}); reconciliation required`,
      { ...effect.details, error: failure },
      effect.providerResourceId,
    );
  }

  private async settleBudget(idempotencyKey: string, budget: BudgetHandles): Promise<void> {
    await this.settleReservation(idempotencyKey, budget.toolKey, 1);
    if (budget.estimatedCost > 0) {
      await this.settleReservation(idempotencyKey, budget.usdKey, budget.estimatedCost);
    }
  }

  /**
   * Commits one reservation. The strict owner-fenced `consumeBudget` is always attempted first; the
   * narrow ambiguity settlement is used only when the reservation demonstrably belongs to an
   * earlier owner of this same operation, and only with a provider intent that is durably EXECUTED.
   */
  private async settleReservation(
    idempotencyKey: string,
    reservationKey: string,
    amount: number,
  ): Promise<void> {
    try {
      await this.workflowRepo.consumeBudget({
        idempotencyKey: reservationKey,
        ownerId: this.workerId,
        amountConsumed: amount,
      });
      return;
    } catch (consumeError) {
      const existing = await this.workflowRepo
        .getToolBudgetReservation(reservationKey)
        .catch(() => null);
      if (!existing) throw consumeError;
      if (existing.status !== 'RESERVED') return;
      if (existing.ownerId === this.workerId) throw consumeError;

      const outcome = await this.workflowRepo.settleAmbiguousToolReservation({
        reservationKey,
        toolOperationKey: idempotencyKey,
        providerIntentKey: idempotencyKey,
        expectedOwnerId: existing.ownerId,
        expectedVersion: existing.version,
        settlement: 'RECONCILE',
        asOf: this.clock(),
      });
      if (!outcome.settled) {
        throw new Error(`Ambiguous budget settlement rejected: ${outcome.reason}`, {
          cause: consumeError,
        });
      }
    }
  }

  private async releaseAmbiguousBudget(
    idempotencyKey: string,
    budget: BudgetHandles,
  ): Promise<void> {
    await Promise.all([
      this.releaseAmbiguousReservation(idempotencyKey, budget.toolKey),
      ...(budget.estimatedCost > 0
        ? [this.releaseAmbiguousReservation(idempotencyKey, budget.usdKey)]
        : []),
    ]);
  }

  private async releaseAmbiguousReservation(
    idempotencyKey: string,
    reservationKey: string,
  ): Promise<void> {
    const existing = await this.workflowRepo
      .getToolBudgetReservation(reservationKey)
      .catch(() => null);
    if (!existing || existing.status !== 'RESERVED') return;
    if (existing.ownerId === this.workerId) {
      await this.workflowRepo
        .releaseBudget({ idempotencyKey: reservationKey, ownerId: this.workerId })
        .catch(() => {});
      return;
    }
    await this.workflowRepo
      .settleAmbiguousToolReservation({
        reservationKey,
        toolOperationKey: idempotencyKey,
        providerIntentKey: idempotencyKey,
        expectedOwnerId: existing.ownerId,
        expectedVersion: existing.version,
        settlement: 'RELEASE',
        asOf: this.clock(),
      })
      .catch(() => {});
  }

  private reject(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    idempotencyKey: string,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<ToolResult> {
    return rejectToolCall(
      toolCall,
      context,
      idempotencyKey,
      input,
      reason,
      this.workflowRepo,
      this.activityRepo,
    );
  }

  private checkAndResetHourlyCeiling(): void {
    const now = this.clock().getTime();
    if (now - this.lastCeilingReset > 3600000) {
      this.hourlyExecutionCount = 0;
      this.lastCeilingReset = now;
    }
  }
}
