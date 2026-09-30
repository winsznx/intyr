import type {
  AttemptState,
  ComponentState,
  ManifestStatus,
  PaymentSessionState,
  RefundState,
  TripState,
} from "./vocab";

/**
 * State machines declared once as data. Guards, docs and the generated
 * reachability tests all read these tables, so an edge exists in exactly one place.
 */
export interface Machine<S extends string> {
  name: string;
  initial: S;
  terminal: readonly S[];
  edges: Readonly<Record<S, readonly S[]>>;
}

export const TRIP_MACHINE: Machine<TripState> = {
  name: "trip",
  initial: "DRAFT",
  terminal: ["CHECKED", "COMMITTED", "COMMIT_NOT_EXECUTED", "RECOVERED", "RECOVERY_FAILED", "PREPARATION_FAILED", "CANCELLED"],
  edges: {
    DRAFT: ["CHECKED", "PREPARING", "CANCELLED"],
    CHECKED: [],
    PREPARING: ["PREPARED", "PREPARED_WITH_WARNINGS", "PREPARATION_FAILED", "CANCELLED"],
    PREPARED: ["REVALIDATING", "READY_TO_COMMIT", "CANCELLED"],
    PREPARED_WITH_WARNINGS: ["REVALIDATING", "READY_TO_COMMIT", "MANUAL_REVIEW", "CANCELLED"],
    PREPARATION_FAILED: [],
    REVALIDATING: ["PREPARED", "PREPARED_WITH_WARNINGS", "READY_TO_COMMIT", "PREPARATION_FAILED", "CANCELLED"],
    READY_TO_COMMIT: ["COMMITTING", "REVALIDATING", "MANUAL_REVIEW", "CANCELLED"],
    COMMITTING: ["COMMITTED_UNVERIFIED", "COMMITTED", "COMMIT_STATUS_UNKNOWN", "RECOVERING", "COMMIT_NOT_EXECUTED"],
    COMMIT_STATUS_UNKNOWN: ["COMMITTED_UNVERIFIED", "COMMITTED", "RECOVERING", "COMMIT_NOT_EXECUTED", "MANUAL_REVIEW"],
    COMMITTED_UNVERIFIED: ["COMMITTED", "RECOVERING", "MANUAL_REVIEW"],
    COMMITTED: [],
    COMMIT_NOT_EXECUTED: [],
    RECOVERING: ["RECOVERED", "RECOVERY_FAILED", "MANUAL_REVIEW"],
    RECOVERED: [],
    RECOVERY_FAILED: [],
    MANUAL_REVIEW: ["READY_TO_COMMIT", "COMMITTED", "RECOVERING", "COMMIT_NOT_EXECUTED", "RECOVERY_FAILED", "CANCELLED"],
    CANCELLED: [],
  },
};

export const COMPONENT_MACHINE: Machine<ComponentState> = {
  name: "component",
  initial: "REQUESTED",
  terminal: ["CANCELLED", "REPLACED"],
  edges: {
    REQUESTED: ["PREPARING", "UNAVAILABLE"],
    PREPARING: ["PREPARED", "PRICE_UNCERTAIN", "UNAVAILABLE"],
    PREPARED: ["PREPARING", "PRICE_UNCERTAIN", "EXPIRED", "UNAVAILABLE", "COMMIT_SUBMITTED", "CANCELLING"],
    PRICE_UNCERTAIN: ["PREPARING", "PREPARED", "UNAVAILABLE", "EXPIRED", "REPLACED"],
    UNAVAILABLE: ["REPLACED"],
    EXPIRED: ["PREPARING", "REPLACED"],
    COMMIT_SUBMITTED: ["COMMIT_RESPONDED", "COMMIT_STATUS_UNKNOWN", "COMMIT_FAILED"],
    COMMIT_RESPONDED: ["CONFIRMED", "COMMIT_STATUS_UNKNOWN", "COMMIT_FAILED"],
    CONFIRMED: ["CANCELLING"],
    COMMIT_STATUS_UNKNOWN: ["CONFIRMED", "COMMIT_FAILED"],
    COMMIT_FAILED: ["RECOVERY_PENDING", "REPLACED"],
    CANCELLING: ["CANCELLED", "CONFIRMED"],
    CANCELLED: [],
    RECOVERY_PENDING: ["REPLACED", "CANCELLED"],
    REPLACED: [],
  },
};

export const MANIFEST_MACHINE: Machine<ManifestStatus> = {
  name: "manifest",
  initial: "ACTIVE",
  terminal: ["SUPERSEDED", "EXPIRED", "REVOKED"],
  edges: { ACTIVE: ["SUPERSEDED", "EXPIRED", "REVOKED"], SUPERSEDED: [], EXPIRED: [], REVOKED: [] },
};

export const PAYMENT_SESSION_MACHINE: Machine<PaymentSessionState> = {
  name: "payment_session",
  initial: "CHALLENGED",
  terminal: ["RECONCILED", "VERIFY_FAILED", "SETTLE_FAILED", "EXPIRED_UNSETTLED"],
  edges: {
    CHALLENGED: ["PROOF_RECEIVED", "EXPIRED_UNSETTLED"],
    PROOF_RECEIVED: ["VERIFIED", "VERIFY_FAILED"],
    VERIFIED: ["SETTLE_SUBMITTED", "EXPIRED_UNSETTLED"],
    SETTLE_SUBMITTED: ["SETTLED", "SETTLE_FAILED", "UNKNOWN"],
    UNKNOWN: ["SETTLED", "CONFIRMED", "SETTLE_FAILED", "EXPIRED_UNSETTLED"],
    SETTLED: ["CONFIRMED", "UNKNOWN"],
    CONFIRMED: ["RECONCILED"],
    RECONCILED: [],
    VERIFY_FAILED: [],
    SETTLE_FAILED: [],
    EXPIRED_UNSETTLED: [],
  },
};

export const REFUND_MACHINE: Machine<RefundState> = {
  name: "refund",
  initial: "REQUESTED",
  terminal: ["CONFIRMED", "FAILED"],
  edges: {
    REQUESTED: ["SUBMITTED", "DEFERRED", "FAILED"],
    DEFERRED: ["SUBMITTED", "FAILED"],
    SUBMITTED: ["CONFIRMED", "FAILED", "UNKNOWN"],
    UNKNOWN: ["CONFIRMED", "FAILED"],
    CONFIRMED: [],
    FAILED: [],
  },
};

export const ATTEMPT_MACHINE: Machine<AttemptState> = {
  name: "commit_attempt",
  initial: "STARTED",
  terminal: ["CONFIRMED", "FAILED"],
  edges: {
    STARTED: ["RESPONDED", "UNKNOWN", "FAILED"],
    RESPONDED: ["CONFIRMED", "UNKNOWN", "FAILED"],
    UNKNOWN: ["CONFIRMED", "FAILED"],
    CONFIRMED: [],
    FAILED: [],
  },
};

export const MACHINES = [
  TRIP_MACHINE,
  COMPONENT_MACHINE,
  MANIFEST_MACHINE,
  PAYMENT_SESSION_MACHINE,
  REFUND_MACHINE,
  ATTEMPT_MACHINE,
] as const;

export class IllegalTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machine}: ${from} -> ${to} is not a permitted transition`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition<S extends string>(machine: Machine<S>, from: S, to: S): boolean {
  return machine.edges[from].includes(to);
}

/** Fails closed: an edge that is not in the table throws. */
export function assertTransition<S extends string>(machine: Machine<S>, from: S, to: S): void {
  if (!canTransition(machine, from, to)) throw new IllegalTransitionError(machine.name, from, to);
}

export function isTerminal<S extends string>(machine: Machine<S>, state: S): boolean {
  return machine.terminal.includes(state);
}

/** States reachable from the initial state, for the generated completeness tests. */
export function reachable<S extends string>(machine: Machine<S>): Set<S> {
  const seen = new Set<S>([machine.initial]);
  const queue: S[] = [machine.initial];
  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const next of machine.edges[state]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
