import type { HandlerResult, PaidActor, PaidContext } from "../payments/ladder";

export type RouteKey =
  | "POST /v1/trips/check"
  | "POST /v1/trips/prepare"
  | "POST /v1/trips/revalidate"
  | "POST /v1/trips/commit"
  | "POST /v1/trips/recover";

export interface DomainHandler {
  /** Runs before any charge. A non-null result is returned to the caller and nothing is charged. */
  precheck?: (body: unknown, actor: PaidActor) => Promise<HandlerResult | null>;
  /** Runs once per settled payment and must be idempotent on ctx.operationId. */
  handler: (ctx: PaidContext) => Promise<HandlerResult>;
}

export type DomainHandlers = Partial<Record<RouteKey, DomainHandler>>;

/** Returned for any route whose domain handler has not been wired yet. Nobody is charged for it. */
export function notAvailable(route: string): HandlerResult {
  return {
    status: 503,
    body: {
      error: "NOT_AVAILABLE",
      outcome: "REFUSE",
      reason_codes: ["ROUTE_NOT_IMPLEMENTED"],
      message: `${route} is not available in this deployment yet. You were not charged.`,
    },
  };
}
