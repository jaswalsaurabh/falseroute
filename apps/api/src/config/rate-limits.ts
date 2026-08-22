/**
 * Single application-owned source for rate-limit and load-shedding numeric
 * budgets. Every budget referenced by middleware and route wiring is declared
 * here so thresholds stay explicit and auditable in one place.
 *
 * These are process-local controls enforcing token-bucket request budgets.
 * They are not cross-instance guarantees and have not been validated by load or
 * abuse testing; treat them as provisional starting points pending production
 * capacity evidence.
 */
export interface RequestClassBudget {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly burstCapacity: number;
  readonly refillRatePerSecond: number;
}

export const REQUEST_CLASS_BUDGETS = {
  /** Baseline default boundary across all routes; 120 req/min with burst capacity 30. */
  default: { windowMs: 60_000, maxRequests: 120, burstCapacity: 30, refillRatePerSecond: 2 },
  /** Authenticated reads and metadata lookups; 120 req/min with burst capacity 30. */
  read: { windowMs: 60_000, maxRequests: 120, burstCapacity: 30, refillRatePerSecond: 2 },
  /** Side-effecting intrusion event creation; 30 req/min with burst capacity 10. */
  write: { windowMs: 60_000, maxRequests: 30, burstCapacity: 10, refillRatePerSecond: 0.5 },
  /** Public liveness probes per source IP; 60 req/min with burst capacity 10. */
  health: { windowMs: 60_000, maxRequests: 60, burstCapacity: 10, refillRatePerSecond: 1 },
  /** Pre-authentication failure abuse boundary per source IP; 20 failures/min. */
  abuse: { windowMs: 60_000, maxRequests: 20, burstCapacity: 20, refillRatePerSecond: 20 / 60 },
} as const satisfies Record<string, RequestClassBudget>;

export type RequestClassName = keyof typeof REQUEST_CLASS_BUDGETS;

/** Maximum in-flight requests before the process sheds load with 503. */
export const MAX_IN_FLIGHT_REQUESTS = 50;

/** Retry-After guidance (seconds) returned on service-overload shedding. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 5;

export function getRequestClassBudget(name: RequestClassName): Readonly<RequestClassBudget> {
  return REQUEST_CLASS_BUDGETS[name];
}
