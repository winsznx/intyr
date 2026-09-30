import { makeDecision } from "./decision";
import type { CommitRequest, Money } from "./schema";
import type { GateDecision, NextAction } from "./types";
import type {
  ComponentState,
  DecisionOutcome,
  Environment,
  EvidenceTier,
  Gate,
  ManifestStatus,
  PaymentSessionState,
  ReasonCode,
  ReviewAuthority,
  TripState,
} from "./vocab";

/**
 * Decision kernel: pure gate functions that turn recorded inputs into a
 * GateDecision. Nothing here calls a supplier, a chain or a database, so any
 * verdict can be replayed from the inputs its hash commits to.
 */

interface Verdict {
  outcome: DecisionOutcome;
  reasons: ReasonCode[];
  next: NextAction[];
  reconcileBy?: string;
  role?: ReviewAuthority;
}

const act = (reason: ReasonCode, next: NextAction[] = []): Verdict => ({ outcome: "ACT", reasons: [reason], next });
const refuse = (reason: ReasonCode, next: NextAction[] = []): Verdict => ({ outcome: "REFUSE", reasons: [reason], next });
const noAction = (reason: ReasonCode, next: NextAction[] = []): Verdict => ({ outcome: "NO_ACTION", reasons: [reason], next });
const unknown = (reason: ReasonCode, reconcileBy: Date): Verdict => ({
  outcome: "UNKNOWN",
  reasons: [reason],
  next: [{ action: "POLL", allowed: true, recommended_before: reconcileBy.toISOString() }],
  reconcileBy: reconcileBy.toISOString(),
});
const review = (reason: ReasonCode, role: ReviewAuthority): Verdict => ({
  outcome: "MANUAL_REVIEW",
  reasons: [reason],
  next: [{ action: "REQUEST_APPROVAL", allowed: role === "SESSION_APPROVER" }],
  role,
});

function decide(
  gate: Gate,
  subject: GateDecision["subject"],
  verdict: Verdict,
  inputs: unknown,
  policyVersion: string,
  now: Date,
  prevDecisionHash?: string,
): Promise<GateDecision> {
  return makeDecision({
    gate,
    subject,
    outcome: verdict.outcome,
    reason_codes: verdict.reasons,
    inputs,
    policy_version: policyVersion,
    next_actions: verdict.next,
    ...(verdict.reconcileBy ? { reconcile_by: verdict.reconcileBy } : {}),
    ...(verdict.role ? { required_role: verdict.role } : {}),
    ...(prevDecisionHash ? { prev_decision_hash: prevDecisionHash } : {}),
    now,
  });
}

const minutesAfter = (t: Date, minutes: number) => new Date(t.getTime() + minutes * 60_000);

// ---------------------------------------------------------------- COMMIT

export interface CommitGateInput {
  trip: {
    trip_id: string;
    state: TripState;
    /** Hash of the manifest the commit started under, once it has started. */
    commit_manifest_hash: string | null;
    component_states: ComponentState[];
  };
  /** The stored manifest named by request.manifest_id, or null when this trip has no such manifest. */
  manifest: {
    manifest_id: string;
    manifest_hash: string;
    status: ManifestStatus;
    expires_at: string;
    currency: string;
    total_minor: number;
    prepare_decision: Pick<GateDecision, "outcome" | "reason_codes">;
  } | null;
  request: CommitRequest;
  /** Session approval bound to one manifest hash, when one was granted. */
  approval: { manifest_hash: string } | null;
  policy_version: string;
  now: Date;
}

const COMMIT_IN_FLIGHT: readonly TripState[] = ["COMMITTING", "COMMIT_STATUS_UNKNOWN", "COMMITTED_UNVERIFIED"];
const COMMIT_DONE: readonly TripState[] = ["COMMITTED", "COMMIT_NOT_EXECUTED", "RECOVERING", "RECOVERED", "RECOVERY_FAILED"];
const COMMITTABLE: readonly TripState[] = ["PREPARED", "PREPARED_WITH_WARNINGS", "READY_TO_COMMIT", "MANUAL_REVIEW"];
const WRITE_STARTED: readonly ComponentState[] = [
  "COMMIT_SUBMITTED",
  "COMMIT_RESPONDED",
  "CONFIRMED",
  "COMMIT_STATUS_UNKNOWN",
  "COMMIT_FAILED",
  "CANCELLING",
  "CANCELLED",
  "RECOVERY_PENDING",
  "REPLACED",
];
const NOT_COMMITTABLE: readonly ComponentState[] = ["REQUESTED", "PREPARING", "PRICE_UNCERTAIN", "UNAVAILABLE", "EXPIRED"];

function commitVerdict(input: CommitGateInput): Verdict {
  const { trip, manifest, request, now } = input;
  const sameCommit = trip.commit_manifest_hash === request.manifest_hash;

  if (COMMIT_DONE.includes(trip.state)) {
    return sameCommit ? noAction("COMMIT_ALREADY_COMPLETED", [{ action: "VERIFY", allowed: true }]) : refuse("TRIP_STATE_CONFLICT");
  }
  if (COMMIT_IN_FLIGHT.includes(trip.state) || trip.component_states.some((s) => WRITE_STARTED.includes(s))) {
    return sameCommit ? noAction("COMMIT_ALREADY_STARTED", [{ action: "POLL", allowed: true }]) : refuse("TRIP_STATE_CONFLICT");
  }
  if (!COMMITTABLE.includes(trip.state)) return refuse("TRIP_STATE_CONFLICT");
  if (!manifest) return refuse("MANIFEST_NOT_FOUND", [{ action: "PREPARE", allowed: true }]);
  if (manifest.manifest_hash !== request.manifest_hash) return refuse("MANIFEST_HASH_MISMATCH");
  if (manifest.status === "SUPERSEDED") return refuse("MANIFEST_SUPERSEDED", [{ action: "REVALIDATE", allowed: true }]);
  if (manifest.status !== "ACTIVE" || Date.parse(manifest.expires_at) <= now.getTime()) {
    return refuse("MANIFEST_EXPIRED", [{ action: "REVALIDATE", allowed: true }]);
  }
  if (request.currency !== manifest.currency) return refuse("CURRENCY_MISMATCH");
  if (request.maximum_total_minor < manifest.total_minor) return refuse("PRICE_ABOVE_MAXIMUM");
  if (trip.component_states.some((s) => NOT_COMMITTABLE.includes(s))) {
    return refuse("COMPONENT_NOT_READY", [{ action: "REVALIDATE", allowed: true }]);
  }

  const prepared = manifest.prepare_decision;
  if (prepared.outcome === "UNKNOWN") {
    return refuse(prepared.reason_codes[0] ?? "COMPONENT_NOT_READY", [{ action: "REVALIDATE", allowed: true }]);
  }
  if (prepared.outcome === "REFUSE" || prepared.outcome === "NO_ACTION") {
    return refuse(prepared.reason_codes[0] ?? "COMPONENT_NOT_READY", [{ action: "PREPARE", allowed: true }]);
  }
  if (prepared.outcome === "MANUAL_REVIEW") {
    if (!input.approval) return review("APPROVAL_REQUIRED", "SESSION_APPROVER");
    if (input.approval.manifest_hash !== request.manifest_hash) return refuse("APPROVAL_INVALID");
  }
  return act("ALL_CHECKS_PASSED", [{ action: "POLL", allowed: true }]);
}

/**
 * COMMIT gate. A repeated commit for the manifest already in flight is a
 * NO_ACTION replay, never a second booking attempt.
 */
export function decideCommit(input: CommitGateInput, prevDecisionHash?: string): Promise<GateDecision> {
  return decide(
    "COMMIT",
    { trip_id: input.trip.trip_id },
    commitVerdict(input),
    input,
    input.policy_version,
    input.now,
    prevDecisionHash,
  );
}

// ---------------------------------------------------- COMPONENT_CONFIRM

/** What the supplier said about the write. Structurally the adapter contract's CommitResult. */
export interface WriteObservation {
  response: "RESPONDED_CONFIRMED" | "RESPONDED_ACCEPTED" | "REJECTED" | "UNKNOWN";
  /** True only when the supplier documents that no booking exists after this response. */
  no_booking_certain: boolean;
}

/** An independent read after the write. Structurally the adapter contract's PostconditionResult. */
export interface ReadObservation {
  found: "PRESENT" | "ABSENT" | "UNKNOWN";
  confirmed: boolean;
  cancelled: boolean;
  /** ABSENT is final only when negative confirmation is supported and the visibility lag has passed. */
  absent_is_final: boolean;
  price: Money | null;
  evidence_tier: EvidenceTier;
}

export interface ConfirmGateInput {
  trip_id: string;
  component_id: string;
  /** Null when no response arrived at all, for example after a crash between submit and response. */
  write: WriteObservation | null;
  /** Null until a read has been attempted. */
  read: ReadObservation | null;
  expected_price: Money;
  price_tolerance_minor: number;
  submitted_at: Date;
  /** How long the supplier may take to settle an answer. After it, an unresolved outcome goes to an operator. */
  reconcile_window_seconds: number;
  policy_version: string;
  now: Date;
}

function confirmVerdict(input: ConfirmGateInput): Verdict {
  const { read, write, expected_price: expected } = input;
  const horizon = new Date(input.submitted_at.getTime() + input.reconcile_window_seconds * 1000);

  if (read?.found === "PRESENT") {
    if (read.cancelled) return refuse("SUPPLIER_REJECTED");
    if (read.confirmed) {
      const priceOk =
        read.price === null ||
        (read.price.currency === expected.currency &&
          Math.abs(read.price.amount_minor - expected.amount_minor) <= input.price_tolerance_minor);
      return priceOk ? act("SUPPLIER_CONFIRMED") : review("POSTCONDITION_MISMATCH", "INTYR_OPERATOR");
    }
  }
  if (read?.found === "ABSENT" && read.absent_is_final) return noAction("NEGATIVE_CONFIRMATION");
  if (write?.response === "REJECTED" && write.no_booking_certain) return refuse("SUPPLIER_REJECTED");
  if (input.now.getTime() >= horizon.getTime()) return review("COMPONENT_STATUS_UNKNOWN", "INTYR_OPERATOR");
  return unknown("COMPONENT_STATUS_UNKNOWN", horizon);
}

/**
 * COMPONENT_CONFIRM gate. CONFIRMED needs an independent read; a supplier
 * saying "confirmed" in the write response is a claim, and a timeout, a 202
 * or a 5xx stays UNKNOWN until a read or the supplier's own rules settle it.
 */
export function decideComponentConfirm(input: ConfirmGateInput, prevDecisionHash?: string): Promise<GateDecision> {
  return decide(
    "COMPONENT_CONFIRM",
    { trip_id: input.trip_id, component_id: input.component_id },
    confirmVerdict(input),
    input,
    input.policy_version,
    input.now,
    prevDecisionHash,
  );
}

/** Component state implied by a COMPONENT_CONFIRM decision. */
export function componentStateAfterConfirm(decision: GateDecision): ComponentState {
  switch (decision.outcome) {
    case "ACT":
      return "CONFIRMED";
    case "REFUSE":
    case "NO_ACTION":
      return "COMMIT_FAILED";
    case "MANUAL_REVIEW":
      // A booking that exists at a different price is still a booking recovery must account for.
      return decision.reason_codes.includes("POSTCONDITION_MISMATCH") ? "CONFIRMED" : "COMMIT_STATUS_UNKNOWN";
    case "UNKNOWN":
      return "COMMIT_STATUS_UNKNOWN";
  }
}

// ----------------------------------------------------- RECOVERY_ACTION

export type RecoveryAction = "CANCEL" | "REPLACE" | "KEEP" | "NONE";

export interface RecoveryGateInput {
  trip_id: string;
  component: {
    component_id: string;
    state: ComponentState;
    required: boolean;
    price: Money;
    refundable: boolean;
    cancellation_fee_minor: number | null;
    free_cancel_until: string | null;
    void_until: string | null;
    has_hold: boolean;
  };
  /** Supplier cancellation quote when the adapter can give one. It takes precedence over clocks. A null fee is unknown. */
  cancel_quote: { cancellable: boolean; fee_minor: number | null } | null;
  replacement: { allowed: boolean; candidate_price_minor: number | null };
  /** Extra spend the caller allows recovery to incur, for fees or a dearer replacement. */
  headroom_minor: number;
  policy_version: string;
  now: Date;
}

const UNSETTLED_WRITE: readonly ComponentState[] = ["COMMIT_SUBMITTED", "COMMIT_RESPONDED", "COMMIT_STATUS_UNKNOWN", "CANCELLING"];
const FAILED: readonly ComponentState[] = ["COMMIT_FAILED", "UNAVAILABLE", "EXPIRED", "RECOVERY_PENDING"];

type RecoveryVerdict = Verdict & { action: RecoveryAction };

function cancelVerdict(input: RecoveryGateInput): RecoveryVerdict {
  const { component: c, cancel_quote: quote, headroom_minor: headroom } = input;
  const open = (iso: string | null) => iso !== null && Date.parse(iso) > input.now.getTime();

  if (quote) {
    if (!quote.cancellable) return { ...refuse("CANCEL_REFUSED_BY_SUPPLIER"), action: "KEEP" };
    if (quote.fee_minor === 0) return { ...act("CANCEL_WITHIN_FREE_WINDOW"), action: "CANCEL" };
    if (quote.fee_minor !== null && quote.fee_minor <= headroom) return { ...act("CANCEL_WITH_FEE"), action: "CANCEL" };
    return { ...review("ADDITIONAL_SPEND_REQUIRED", "SESSION_APPROVER"), action: "NONE" };
  }
  if (c.refundable && open(c.free_cancel_until)) return { ...act("CANCEL_WITHIN_FREE_WINDOW"), action: "CANCEL" };
  if (open(c.void_until)) return { ...act("CANCEL_WITHIN_FREE_WINDOW"), action: "CANCEL" };
  if (!c.refundable) return { ...refuse("IRREVERSIBLE_COMPONENT"), action: "KEEP" };
  if (c.cancellation_fee_minor !== null && c.cancellation_fee_minor <= headroom) {
    return { ...act("CANCEL_WITH_FEE"), action: "CANCEL" };
  }
  return { ...review("ADDITIONAL_SPEND_REQUIRED", "SESSION_APPROVER"), action: "NONE" };
}

function recoveryVerdict(input: RecoveryGateInput): RecoveryVerdict {
  const { component: c, replacement } = input;

  if (c.state === "CANCELLED" || c.state === "REPLACED") return { ...noAction("ALREADY_CANCELLED"), action: "NONE" };
  if (UNSETTLED_WRITE.includes(c.state)) {
    return { ...unknown("COMPONENT_STATUS_UNKNOWN", minutesAfter(input.now, 5)), action: "NONE" };
  }
  if (c.state === "CONFIRMED") return cancelVerdict(input);
  if (FAILED.includes(c.state)) {
    if (!c.required) return { ...noAction("NOTHING_TO_RECOVER"), action: "NONE" };
    if (!replacement.allowed) return { ...noAction("OUTSIDE_RECOVERY_BOUNDARY"), action: "NONE" };
    if (replacement.candidate_price_minor === null) return { ...noAction("NO_REPLACEMENT_AVAILABLE"), action: "NONE" };
    if (replacement.candidate_price_minor - c.price.amount_minor <= input.headroom_minor) {
      return { ...act("REPLACEMENT_WITHIN_HEADROOM"), action: "REPLACE" };
    }
    return { ...review("ADDITIONAL_SPEND_REQUIRED", "SESSION_APPROVER"), action: "NONE" };
  }
  if (c.has_hold && (c.state === "PREPARED" || c.state === "PRICE_UNCERTAIN")) {
    return { ...act("RELEASE_UNCOMMITTED_HOLD"), action: "CANCEL" };
  }
  return { ...noAction("NOTHING_TO_RECOVER"), action: "NONE" };
}

/**
 * RECOVERY_ACTION gate for one component. It never acts on a component whose
 * write is unsettled, never replaces a slot that might already be booked, and
 * keeps an irreversible booking rather than pretending it can be undone.
 */
export async function decideRecoveryAction(
  input: RecoveryGateInput,
  prevDecisionHash?: string,
): Promise<{ decision: GateDecision; action: RecoveryAction }> {
  const verdict = recoveryVerdict(input);
  const decision = await decide(
    "RECOVERY_ACTION",
    { trip_id: input.trip_id, component_id: input.component.component_id },
    verdict,
    input,
    input.policy_version,
    input.now,
    prevDecisionHash,
  );
  return { decision, action: verdict.action };
}

// ------------------------------------------------------ PAYMENT_ACCEPT

/** What a payment must be bound to. Any difference between expected and observed refuses it. */
export interface PaymentBinding {
  session_id: string;
  route: string;
  body_hash: string;
  network: string;
  asset_id: number;
  amount_minor: number;
  pay_to: string;
  manifest_hash: string | null;
}

export interface PaymentGateInput {
  expected: PaymentBinding & { expires_at: string };
  observed: PaymentBinding;
  session_state: PaymentSessionState;
  policy_version: string;
  now: Date;
}

const PAYMENT_CONSUMED: readonly PaymentSessionState[] = ["SETTLED", "CONFIRMED", "RECONCILED"];

function paymentVerdict(input: PaymentGateInput): Verdict {
  const { expected: e, observed: o } = input;
  if (PAYMENT_CONSUMED.includes(input.session_state)) {
    return o.route === e.route && o.body_hash === e.body_hash
      ? noAction("IDEMPOTENT_REPLAY", [{ action: "POLL", allowed: true }])
      : refuse("PAYMENT_ALREADY_CONSUMED");
  }
  if (input.session_state === "UNKNOWN" || input.session_state === "SETTLE_SUBMITTED") {
    return unknown("PAYMENT_SETTLEMENT_UNKNOWN", minutesAfter(input.now, 2));
  }
  if (Date.parse(e.expires_at) <= input.now.getTime()) return refuse("PAYMENT_SESSION_EXPIRED");
  if (o.network !== e.network) return refuse("PAYMENT_WRONG_NETWORK");
  if (o.asset_id !== e.asset_id) return refuse("PAYMENT_WRONG_ASSET");
  if (o.amount_minor !== e.amount_minor) return refuse("PAYMENT_WRONG_AMOUNT");
  if (o.pay_to !== e.pay_to) return refuse("PAYMENT_WRONG_RECEIVER");
  if (o.session_id !== e.session_id || o.route !== e.route || o.body_hash !== e.body_hash || o.manifest_hash !== e.manifest_hash) {
    return refuse("PAYMENT_BINDING_MISMATCH");
  }
  return act("ALL_CHECKS_PASSED");
}

/** PAYMENT_ACCEPT gate: runs before any settlement and before any supplier work. */
export function decidePaymentAccept(input: PaymentGateInput): Promise<GateDecision> {
  return decide(
    "PAYMENT_ACCEPT",
    { session_id: input.expected.session_id },
    paymentVerdict(input),
    input,
    input.policy_version,
    input.now,
  );
}

// --------------------------------------------------------------- REFUND

export interface RefundGateInput {
  session_id: string;
  environment: Environment;
  /** DELIVERED: the paid result was returned. The other two mean the fee bought nothing. */
  delivery: "DELIVERED" | "INTYR_FAILURE" | "COMMIT_NOT_EXECUTED";
  amount_minor: number;
  policy_version: string;
  now: Date;
}

function refundVerdict(input: RefundGateInput): Verdict {
  if (input.delivery === "DELIVERED") return noAction("FEE_KEPT_OUTCOME_DELIVERED");
  if (input.environment === "TESTNET") return act("FEE_REFUND_INTYR_FAILURE");
  return review("FEE_REFUND_DEFERRED_MAINNET", "INTYR_OPERATOR");
}

/**
 * REFUND gate. Mainnet fee refunds go to an operator instead of executing
 * automatically in R0, because automatic refund round trips look like wash
 * traffic on the challenge leaderboard. TestNet refunds execute.
 */
export function decideRefund(input: RefundGateInput): Promise<GateDecision> {
  return decide("REFUND", { session_id: input.session_id }, refundVerdict(input), input, input.policy_version, input.now);
}
