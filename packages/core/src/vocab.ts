/**
 * Canonical vocabulary shared by every Intyr package (internal decision D4).
 * Each list is the single source for its union type, its runtime validator
 * and its JSON Schema, so a name can only change in one place.
 */

export const ENVIRONMENTS = ["MAINNET", "TESTNET"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DECISION_OUTCOMES = ["ACT", "NO_ACTION", "UNKNOWN", "REFUSE", "MANUAL_REVIEW"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const GATES = ["PAYMENT_ACCEPT", "PREPARE", "COMMIT", "COMPONENT_CONFIRM", "RECOVERY_ACTION", "REFUND"] as const;
export type Gate = (typeof GATES)[number];

export const REVIEW_AUTHORITIES = ["SESSION_APPROVER", "INTYR_OPERATOR"] as const;
export type ReviewAuthority = (typeof REVIEW_AUTHORITIES)[number];

export const ACTOR_TYPES = ["SYSTEM", "PAYER", "SESSION_USER", "OPERATOR"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const TRIP_STATES = [
  "DRAFT",
  "CHECKED",
  "PREPARING",
  "PREPARED",
  "PREPARED_WITH_WARNINGS",
  "PREPARATION_FAILED",
  "REVALIDATING",
  "READY_TO_COMMIT",
  "COMMITTING",
  "COMMIT_STATUS_UNKNOWN",
  "COMMITTED_UNVERIFIED",
  "COMMITTED",
  "COMMIT_NOT_EXECUTED",
  "RECOVERING",
  "RECOVERED",
  "RECOVERY_FAILED",
  "MANUAL_REVIEW",
  "CANCELLED",
] as const;
export type TripState = (typeof TRIP_STATES)[number];

export const MANIFEST_STATUSES = ["ACTIVE", "SUPERSEDED", "EXPIRED", "REVOKED"] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

export const COMPONENT_STATES = [
  "REQUESTED",
  "PREPARING",
  "PREPARED",
  "PRICE_UNCERTAIN",
  "UNAVAILABLE",
  "EXPIRED",
  "COMMIT_SUBMITTED",
  "COMMIT_RESPONDED",
  "CONFIRMED",
  "COMMIT_STATUS_UNKNOWN",
  "COMMIT_FAILED",
  "CANCELLING",
  "CANCELLED",
  "RECOVERY_PENDING",
  "REPLACED",
] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

export const OUTCOME_VERIFICATIONS = ["PENDING_WINDOW", "VERIFIED", "CONTRADICTED", "TIMEOUT"] as const;
export type OutcomeVerification = (typeof OUTCOME_VERIFICATIONS)[number];

export const PAYMENT_SESSION_STATES = [
  "CHALLENGED",
  "PROOF_RECEIVED",
  "VERIFIED",
  "SETTLE_SUBMITTED",
  "SETTLED",
  "CONFIRMED",
  "RECONCILED",
  "VERIFY_FAILED",
  "SETTLE_FAILED",
  "EXPIRED_UNSETTLED",
  "UNKNOWN",
] as const;
export type PaymentSessionState = (typeof PAYMENT_SESSION_STATES)[number];

export const REFUND_STATES = ["REQUESTED", "SUBMITTED", "CONFIRMED", "FAILED", "UNKNOWN", "DEFERRED"] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const ATTEMPT_STATES = ["STARTED", "RESPONDED", "CONFIRMED", "FAILED", "UNKNOWN"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const COMPONENT_TYPES = ["FLIGHT", "HOTEL", "GROUND", "ESIM", "DATA", "OTHER"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const PREPARATION_MODES = [
  "HARD_HOLD",
  "SOFT_HOLD",
  "REVALIDATED",
  "INSTANT_COMMIT_ONLY",
  "UNSUPPORTED",
] as const;
export type PreparationMode = (typeof PREPARATION_MODES)[number];

export const LEG_CLASSES = ["SUPPLIER_SANDBOX", "SIMULATED", "CALLER_SUPPLIED", "X402_MERCHANT"] as const;
export type LegClass = (typeof LEG_CLASSES)[number];

/** CALLER_ASSERTED marks data Intyr did not read from any supplier. */
export const EVIDENCE_GRADES = [
  "SIMULATED",
  "CALLER_ASSERTED",
  "SUPPLIER_SANDBOX",
  "SUPPLIER_PRODUCTION",
  "SUPPLIER_SIGNED",
] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

/** Manifest-level warning set by the weakest evidence grade among its components. */
export const EVIDENCE_BANNERS = ["SIMULATED", "CALLER_ASSERTED", "SUPPLIER_SANDBOX", "NONE"] as const;
export type EvidenceBanner = (typeof EVIDENCE_BANNERS)[number];

/** E0 verified webhook, E1 supplier read after write, E2 independent channel (airline locator, hotel code). */
export const EVIDENCE_TIERS = ["E0", "E1", "E2"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const REFUND_DESTINATIONS = ["CASH", "CREDIT", "NONE", "UNKNOWN"] as const;
export type RefundDestination = (typeof REFUND_DESTINATIONS)[number];

export const REFUND_CERTAINTIES = ["QUOTED", "ESTIMATED", "UNKNOWN"] as const;
export type RefundCertainty = (typeof REFUND_CERTAINTIES)[number];

export const CONFIRMATION_MODES = ["INSTANT", "ASYNC", "MANUAL"] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];

export const PAYER_CLASSES = ["EXTERNAL_ANON", "EXTERNAL_ORG", "INTERNAL_VALIDATION", "SANDBOX"] as const;
export type PayerClass = (typeof PAYER_CLASSES)[number];

export const ADAPTER_IDS = ["duffel-flights", "liteapi-hotels", "sim-ground", "sim-hostile", "caller-supplied", "x402-merchant"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

/**
 * Faults the seeded simulator can inject, one name per simulator scenario, so
 * a pre-registered fault matrix maps 1:1 to what the Worker runs. Every
 * injected fault is recorded in the manifest.
 */
export const SIMULATED_FAULTS = [
  "PRICE_DIVERGENCE",
  "UNAVAILABLE_AT_COMMIT",
  "COMMIT_REJECT",
  "TIMEOUT_BOOKED",
  "TIMEOUT_NOT_BOOKED",
  "ACCEPTED_ASYNC_CONFIRMS",
  "ACCEPTED_ASYNC_FAILS",
  "RESPONSE_OK_STATUS_DISAGREES",
  "CANCEL_REFUSED",
  "NON_REFUNDABLE",
  "DUPLICATE_ON_RETRY",
  "HOLD_EXPIRY",
] as const;
export type SimulatedFault = (typeof SIMULATED_FAULTS)[number];

/** What a sandbox request may name per component: any fault, or HAPPY for a simulated control leg. */
export const SIM_SCENARIOS = ["HAPPY", ...SIMULATED_FAULTS] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

export const PLAN_VERDICTS = ["COMMIT_NOW", "REVALIDATE_FIRST", "NEEDS_APPROVAL", "DO_NOT_COMMIT"] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

export const PROOF_STATES = [
  "PROOF_VERIFIED",
  "PROOF_PARTIAL",
  "SIGNATURE_INVALID",
  "HASH_MISMATCH",
  "ANCHOR_NOT_FOUND",
  "ANCHOR_UNCONFIRMED",
  "MANIFEST_SUPERSEDED",
  "INDEXER_UNAVAILABLE",
] as const;
export type ProofState = (typeof PROOF_STATES)[number];

export const ANCHOR_MODES = ["SEPARATE_NOTE_TRANSACTION", "SEPARATE_APP_CALL", "ATOMIC_GROUP_APP_CALL", "UNANCHORED"] as const;
export type AnchorMode = (typeof ANCHOR_MODES)[number];

/**
 * Stable reason codes carried by decisions and errors. A refusal or an unknown
 * outcome always names at least one of these so callers can branch on data.
 */
export const REASON_CODES = [
  "INVALID_REQUEST",
  "CURRENCY_MISMATCH",
  "DUPLICATE_LEG_ID",
  "UNKNOWN_DEPENDENCY",
  "BUDGET_EXCEEDED",
  "IRREVERSIBLE_EXPOSURE_ABOVE_CAP",
  "READINESS_BELOW_THRESHOLD",
  "UNSUPPORTED_PREPARATION_MODE",
  "MISSING_PRICE_VALIDITY",
  "PRICE_VALIDITY_EXPIRED",
  "PRICE_VALIDITY_NEAR_EXPIRY",
  "PRICE_CHANGE_ABOVE_LIMIT",
  "HOLD_EXPIRED",
  "ALL_CHECKS_PASSED",
  "MANIFEST_NOT_FOUND",
  "MANIFEST_HASH_MISMATCH",
  "MANIFEST_EXPIRED",
  "MANIFEST_SUPERSEDED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "COMMIT_ALREADY_STARTED",
  "COMMIT_ALREADY_COMPLETED",
  "TRIP_STATE_CONFLICT",
  "COMPONENT_STATUS_UNKNOWN",
  "COMPONENT_NOT_READY",
  "SUPPLIER_CONFIRMED",
  "SUPPLIER_REJECTED",
  "NEGATIVE_CONFIRMATION",
  "POSTCONDITION_MISMATCH",
  "PRICE_ABOVE_MAXIMUM",
  "IRREVERSIBLE_COMPONENT",
  "OUTSIDE_RECOVERY_BOUNDARY",
  "ADDITIONAL_SPEND_REQUIRED",
  "ALREADY_CANCELLED",
  "NOTHING_TO_RECOVER",
  "CANCEL_WITHIN_FREE_WINDOW",
  "CANCEL_WITH_FEE",
  "CANCEL_REFUSED_BY_SUPPLIER",
  "RELEASE_UNCOMMITTED_HOLD",
  "REPLACEMENT_WITHIN_HEADROOM",
  "NO_REPLACEMENT_AVAILABLE",
  "DUPLICATE_RISK_UNBOUNDED",
  "PAYMENT_BINDING_MISMATCH",
  "PAYMENT_SESSION_EXPIRED",
  "PAYMENT_ALREADY_CONSUMED",
  "PAYMENT_WRONG_NETWORK",
  "PAYMENT_WRONG_ASSET",
  "PAYMENT_WRONG_AMOUNT",
  "PAYMENT_WRONG_RECEIVER",
  "PAYMENT_SETTLEMENT_UNKNOWN",
  "PAYMENT_CONFIRMED",
  "FEE_KEPT_OUTCOME_DELIVERED",
  "FEE_REFUND_INTYR_FAILURE",
  "FEE_REFUND_DEFERRED_MAINNET",
  "IDEMPOTENT_REPLAY",
  "ROUTE_NOT_IMPLEMENTED",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
