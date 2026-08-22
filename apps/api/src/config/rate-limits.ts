/**
 * Single application-owned source for rate-limit and load-shedding numeric
 * budgets. Every budget referenced by middleware and route wiring is declared
 * here so thresholds stay explicit and auditable in one place.
 *
 * These are process-local demonstration controls. They are not cross-instance
 * guarantees and have not been validated by load or abuse testing; treat them
 * as provisional starting points pending production capacity evidence.
 */
export interface RequestClassBudget {
  readonly windowMs: number;
  readonly maxRequests: number;
}

export const REQUEST_CLASS_BUDGETS = {
  /** Reads and metadata lookups. Default matches the prior demo baseline. */
  read: { windowMs: 60_000, maxRequests: 100 },
  /** Side-effecting writes, which are more expensive and higher risk. */
  write: { windowMs: 60_000, maxRequests: 20 },
  /** Liveness and readiness probes; bounded to keep probes available. */
  health: { windowMs: 60_000, maxRequests: 60 },
  /** Unauthenticated pre-auth abuse boundary per source address. */
  abuse: { windowMs: 60_000, maxRequests: 20 },
} as const satisfies Record<string, RequestClassBudget>;

export type RequestClassName = keyof typeof REQUEST_CLASS_BUDGETS;

/** Maximum in-flight requests before the process sheds load with 503. */
export const MAX_IN_FLIGHT_REQUESTS = 50;

/** Retry-After guidance (seconds) returned on service-overload shedding. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 5;

export function getRequestClassBudget(name: RequestClassName): Readonly<RequestClassBudget> {
  return REQUEST_CLASS_BUDGETS[name];
}
