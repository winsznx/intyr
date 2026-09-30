import type {
  ComponentState,
  DecisionOutcome,
  EvidenceGrade,
  LegClass,
  PaymentState,
  PreparationMode,
  ProofState,
  TripState,
} from "./types";

export type Tone =
  | "neutral"
  | "outline"
  | "running"
  | "info"
  | "success"
  | "success-outline"
  | "danger"
  | "amber"
  | "review"
  | "unknown";

export interface StateLabel {
  label: string;
  tone: Tone;
  running?: boolean;
  terminal?: boolean;
}

/** Fixed copy for an unconfirmed supplier or payment outcome. Do not reword per screen. */
export const UNKNOWN_COPY =
  "We have not confirmed whether the supplier completed this. Do not retry. Intyr is checking and will update this trip.";

export const UNKNOWN_PAYMENT_COPY =
  "The payment was submitted but its settlement is not confirmed yet. Do not pay again. Intyr is reading the chain and will update this page.";

export const TRIP_STATE: Record<TripState, StateLabel> = {
  DRAFT: { label: "Draft", tone: "outline" },
  CHECKED: { label: "Plan checked", tone: "info", terminal: true },
  PREPARING: { label: "Preparing", tone: "running", running: true },
  PREPARED: { label: "Prepared", tone: "outline" },
  PREPARED_WITH_WARNINGS: { label: "Prepared with warnings", tone: "amber" },
  PREPARATION_FAILED: { label: "Preparation failed", tone: "danger", terminal: true },
  REVALIDATING: { label: "Rechecking prices", tone: "running", running: true },
  READY_TO_COMMIT: { label: "Ready to commit", tone: "info" },
  COMMITTING: { label: "Committing", tone: "running", running: true },
  COMMIT_STATUS_UNKNOWN: { label: "Status unknown, checking", tone: "unknown", running: true },
  COMMITTED_UNVERIFIED: { label: "Committed, verifying", tone: "running", running: true },
  COMMITTED: { label: "Committed", tone: "success", terminal: true },
  COMMIT_NOT_EXECUTED: { label: "Not committed", tone: "neutral", terminal: true },
  RECOVERING: { label: "Recovering", tone: "amber", running: true },
  RECOVERED: { label: "Recovered", tone: "success-outline", terminal: true },
  RECOVERY_FAILED: { label: "Recovery failed", tone: "danger", terminal: true },
  MANUAL_REVIEW: { label: "Needs review", tone: "review" },
  CANCELLED: { label: "Cancelled", tone: "neutral", terminal: true },
  SERVICING: { label: "Servicing", tone: "amber", running: true },
};

export const COMPONENT_STATE: Record<ComponentState, StateLabel> = {
  REQUESTED: { label: "Requested", tone: "outline" },
  PREPARING: { label: "Checking supplier", tone: "running", running: true },
  PREPARED: { label: "Prepared", tone: "outline" },
  PRICE_UNCERTAIN: { label: "Price may move", tone: "amber" },
  UNAVAILABLE: { label: "Unavailable", tone: "danger", terminal: true },
  EXPIRED: { label: "Expired", tone: "neutral", terminal: true },
  COMMIT_SUBMITTED: { label: "Booking sent", tone: "running", running: true },
  COMMIT_RESPONDED: { label: "Supplier replied, confirming", tone: "running", running: true },
  CONFIRMED: { label: "Confirmed", tone: "success", terminal: true },
  COMMIT_STATUS_UNKNOWN: { label: "Unknown, checking", tone: "unknown", running: true },
  COMMIT_FAILED: { label: "Booking failed", tone: "danger", terminal: true },
  CANCELLING: { label: "Cancelling", tone: "amber", running: true },
  CANCELLED: { label: "Cancelled", tone: "neutral", terminal: true },
  RECOVERY_PENDING: { label: "Recovery pending", tone: "amber" },
  REPLACED: { label: "Replaced", tone: "neutral", terminal: true },
};

export interface DecisionLabel {
  label: string;
  tone: Tone;
  meaning: string;
}

export const DECISION: Record<DecisionOutcome, DecisionLabel> = {
  ACT: { label: "ACT", tone: "success", meaning: "Preconditions held and the action was authorized." },
  NO_ACTION: { label: "NO_ACTION", tone: "neutral", meaning: "Nothing needed doing, so nothing was done." },
  UNKNOWN: { label: "UNKNOWN", tone: "unknown", meaning: "The outcome could not be established yet. Nothing is retried until it is." },
  REFUSE: { label: "REFUSE", tone: "danger", meaning: "Intyr declined to act, and says why." },
  MANUAL_REVIEW: { label: "MANUAL_REVIEW", tone: "review", meaning: "A person has to decide before anything moves." },
};

export const PAYMENT_STATE: Record<PaymentState, StateLabel> = {
  NONE: { label: "No payment", tone: "outline" },
  CHALLENGED: { label: "Payment requested", tone: "outline" },
  PROOF_RECEIVED: { label: "Payment received", tone: "running", running: true },
  VERIFIED: { label: "Payment verified", tone: "running", running: true },
  SETTLE_SUBMITTED: { label: "Settling", tone: "running", running: true },
  SETTLED: { label: "Settled", tone: "info" },
  CONFIRMED: { label: "Settled on chain", tone: "success" },
  RECONCILED: { label: "Reconciled", tone: "success" },
  VERIFY_FAILED: { label: "Payment rejected", tone: "danger", terminal: true },
  SETTLE_FAILED: { label: "Settlement failed", tone: "danger", terminal: true },
  EXPIRED_UNSETTLED: { label: "Expired, not charged", tone: "neutral", terminal: true },
  UNKNOWN: { label: "Settlement unknown", tone: "unknown", running: true },
};

export interface ModeLabel {
  label: string;
  short: string;
  explain: string;
}

export const PREPARATION_MODE: Record<PreparationMode, ModeLabel> = {
  HARD_HOLD: {
    label: "Held, price guaranteed",
    short: "Held",
    explain: "The supplier reserved the space and guaranteed the price until the times it returned.",
  },
  SOFT_HOLD: {
    label: "Held, price can move",
    short: "Soft hold",
    explain: "The supplier reserved the space, but the price can change before payment.",
  },
  REVALIDATED: {
    label: "Price checked, not held",
    short: "Checked",
    explain: "Price and availability were confirmed at the time shown. Nothing is reserved.",
  },
  INSTANT_COMMIT_ONLY: {
    label: "Must pay to book",
    short: "Pay to book",
    explain: "This supplier cannot hold or prepare the leg. It is booked and paid only at commit time.",
  },
  UNSUPPORTED: {
    label: "Not supported",
    short: "Unsupported",
    explain: "This supplier cannot meet the requested terms.",
  },
  BONDED_QUOTE: {
    label: "Bonded quote",
    short: "Bonded",
    explain: "Not available in this release.",
  },
};

export const EVIDENCE_GRADE: Record<EvidenceGrade, { label: string; tone: Tone }> = {
  SIMULATED: { label: "Simulated supplier", tone: "amber" },
  SUPPLIER_SANDBOX: { label: "Supplier sandbox (test mode)", tone: "amber" },
  CALLER_ASSERTED: { label: "Reported by the calling agent", tone: "amber" },
  SUPPLIER_PRODUCTION: { label: "Live supplier", tone: "outline" },
  SUPPLIER_SIGNED: { label: "Supplier signed", tone: "outline" },
};

export const LEG_CLASS: Record<LegClass, string> = {
  SUPPLIER_SANDBOX: "Supplier test mode",
  SIMULATED: "Seeded simulator",
  CALLER_SUPPLIED: "Offer supplied by the agent",
  X402_MERCHANT: "x402 merchant purchase",
};

export const COMPONENT_TYPE: Record<string, string> = {
  FLIGHT: "Flight",
  HOTEL: "Hotel",
  GROUND: "Ground transfer",
  TRANSFER: "Ground transfer",
  RAIL: "Rail",
  EVENT: "Event",
  ESIM: "Travel eSIM",
  OTHER: "Other",
};

export const PROOF_STATE: Record<ProofState, { label: string; tone: Tone; explain: string }> = {
  PROOF_VERIFIED: {
    label: "Verified",
    tone: "success",
    explain: "The signature, the hash and the Algorand anchor all match this manifest.",
  },
  PROOF_PARTIAL: {
    label: "Partly verified",
    tone: "amber",
    explain: "The signature and hash match. The chain anchor is still pending.",
  },
  SIGNATURE_INVALID: {
    label: "Signature does not match",
    tone: "danger",
    explain: "The manifest was not signed by a published Intyr key, or it changed after signing.",
  },
  HASH_MISMATCH: {
    label: "Hash does not match",
    tone: "danger",
    explain: "The manifest content differs from the hash that was anchored.",
  },
  ANCHOR_NOT_FOUND: {
    label: "Anchor not found",
    tone: "danger",
    explain: "No Algorand transaction with this anchor was found.",
  },
  ANCHOR_UNCONFIRMED: {
    label: "Anchor unconfirmed",
    tone: "amber",
    explain: "The anchor transaction was submitted but is not confirmed yet.",
  },
  MANIFEST_SUPERSEDED: {
    label: "Superseded",
    tone: "neutral",
    explain: "This manifest was replaced by a newer one. It still verifies, but it is not the current record.",
  },
  INDEXER_UNAVAILABLE: {
    label: "Chain check unavailable",
    tone: "unknown",
    explain: "The Algorand indexer did not answer. Integrity checks ran, the anchor check did not.",
  },
};

const REASONS: Record<string, string> = {
  APPROVAL_REQUIRED: "A person has to approve this trip before it can be committed.",
  MANIFEST_EXPIRED: "The prepared offer expired. Recheck prices to get a fresh manifest.",
  MANIFEST_HASH_MISMATCH: "The manifest changed since it was shown. Review the current version.",
  APPROVAL_EXPIRED: "The approval window closed. Request a new one.",
  POLICY_DENIED: "The trip is outside the policy limits for this session.",
  CONFIDENCE_BELOW_THRESHOLD: "Readiness is below the minimum set for this trip.",
  UNSUPPORTED_PREPARATION_MODE: "A supplier cannot prepare this leg under the requested terms.",
  JURISDICTION_RESTRICTED: "This trip is outside the allowed jurisdictions.",
  IRREVERSIBLE_COMPONENT: "This leg cannot be cancelled or refunded, so Intyr will not unwind it automatically.",
  EVIDENCE_UNVERIFIABLE: "The supplier's answer could not be checked through an independent read.",
  NO_CAPABLE_PROVIDER: "No connected supplier can serve this leg.",
  COMMIT_ALREADY_STARTED: "A commit for this manifest is already running. Showing that one instead.",
  IDEMPOTENT_REPLAY: "This request was already handled. Showing the original result.",
  ALREADY_CONFIRMED: "The supplier had already confirmed this leg.",
  ALREADY_CANCELLED: "The leg was already cancelled.",
  NOTHING_TO_RECOVER: "Every leg is in a consistent state. There is nothing to recover.",
  PROVIDER_STATUS_UNKNOWN: "The supplier did not confirm either way yet.",
  CANCEL_STATUS_UNKNOWN: "The supplier has not confirmed the cancellation yet.",
  OUTSIDE_RECOVERY_BOUNDARY: "The fix would go beyond the limits agreed before payment.",
  ADDITIONAL_SPEND_REQUIRED: "Recovering needs more money than the limit allows. A person has to decide.",
  AMBIGUOUS_STATE: "The supplier's answers disagree. A person has to decide.",
  PRICE_CHANGED: "The supplier changed the price.",
  OFFER_EXPIRED: "The supplier offer expired.",
  OFFER_NO_LONGER_AVAILABLE: "The supplier no longer has this offer.",
  DUPLICATE_BOOKING: "The supplier reported a booking that already exists.",
  INSUFFICIENT_BALANCE: "The booking account at the supplier does not have enough balance.",
  UNBOUNDED_DUPLICATE_RISK: "This supplier offers no way to rule out a duplicate booking, so autonomous commit is refused.",
  PAYMENT_SETTLEMENT_PENDING: "The service fee is still settling.",
  ANCHOR_REQUIRED_NOT_CONFIRMED: "The chain record for this commit is not confirmed yet.",
  SEA_INVALID: "The action was not authorized for this exact request.",
  BOND_INSUFFICIENT: "Provider protection is not available in this release.",
  TRIGGER_NOT_MATCHED: "The trigger conditions were not met.",
};

export function describeReason(code: string): string {
  return REASONS[code] ?? humanize(code);
}

export function humanize(code: string): string {
  const text = code.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

export function tripState(state: string): StateLabel {
  return TRIP_STATE[state as TripState] ?? { label: humanize(state).replace(/\.$/, ""), tone: "neutral" };
}

export function componentState(state: string): StateLabel {
  return COMPONENT_STATE[state as ComponentState] ?? { label: humanize(state).replace(/\.$/, ""), tone: "neutral" };
}

export function paymentState(state: string): StateLabel {
  return PAYMENT_STATE[state as PaymentState] ?? { label: humanize(state).replace(/\.$/, ""), tone: "neutral" };
}
