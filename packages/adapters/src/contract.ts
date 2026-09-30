/**
 * Adapter contract between Intyr's commit kernel and one supplier source.
 * Names follow internal decision D4 (R0 canonical vocabulary).
 *
 * Every write method returns what the supplier said, never a conclusion. Only
 * `postcondition` (an independent read after the write) may be used by the
 * kernel to move a component to CONFIRMED.
 */

export type ComponentType = "FLIGHT" | "HOTEL" | "GROUND";

export type AdapterId =
  | "duffel-flights"
  | "liteapi-hotels"
  | "sim-ground"
  | "sim-hostile"
  | "caller-supplied"
  | "x402-merchant";

export type LegClass = "SUPPLIER_SANDBOX" | "SIMULATED" | "CALLER_SUPPLIED" | "X402_MERCHANT";

/** CALLER_ASSERTED marks data Intyr did not read from any supplier. */
export type EvidenceGrade =
  | "SIMULATED"
  | "CALLER_ASSERTED"
  | "SUPPLIER_SANDBOX"
  | "SUPPLIER_PRODUCTION"
  | "SUPPLIER_SIGNED";

export type EvidenceTier = "E0" | "E1" | "E2";

export type SupplierEnvironment = "TEST" | "LIVE" | "NONE";

export type PreparationMode =
  | "HARD_HOLD"
  | "SOFT_HOLD"
  | "REVALIDATED"
  | "INSTANT_COMMIT_ONLY"
  | "UNSUPPORTED";

export type RefundDestination = "CASH" | "CREDIT" | "NONE" | "UNKNOWN";
export type RefundAmountCertainty = "QUOTED" | "ESTIMATED" | "UNKNOWN";
export type ConfirmationMode = "INSTANT" | "ASYNC" | "MANUAL";

/** Integer minor units (cents for USD). Supplier decimal strings are converted once, at the adapter edge. */
export interface Money {
  amount_minor: number;
  currency: string;
}

/**
 * Suppliers expose several independent clocks. A single `expires_at` loses the
 * difference between "price guaranteed", "seat held" and "free to cancel".
 */
export interface ComponentClocks {
  price_valid_until: string | null;
  inventory_held_until: string | null;
  free_cancel_until: string | null;
  void_until: string | null;
  refund_destination: RefundDestination;
  refund_amount_certainty: RefundAmountCertainty;
  confirmation_mode: ConfirmationMode;
  supplier_can_cancel: boolean;
}

export interface AdapterMetadata {
  adapter_id: AdapterId;
  provider_id: string;
  version: string;
  component_types: ComponentType[];
  leg_class: LegClass;
  evidence_grade: EvidenceGrade;
  supplier_environment: SupplierEnvironment;
  /** False when a required credential is missing. The adapter then refuses every call. */
  configured: boolean;
  unconfigured_reason: string | null;
}

export interface AdapterCapabilities {
  preparation_modes: PreparationMode[];
  supports_hold: boolean;
  supports_cancel: boolean;
  cancel_quote: "SUPPLIER" | "COMPUTED" | "NONE";
  commit_idempotency: "NONE" | "REFERENCE" | "KEY";
  status_lookup: "BY_REFERENCE" | "BY_SEARCH" | "NONE";
  /** True when an absent read after `visibility_lag_seconds` proves no booking exists. */
  negative_confirmation: boolean;
  visibility_lag_seconds: number;
  duplicate_sweep: boolean;
  commit_timeout_ms: number;
}

/** Synthetic sandbox traveler. Real traveler PII never reaches R0 adapters. */
export interface SandboxTraveler {
  given_name: string;
  family_name: string;
  born_on: string;
  email: string;
  phone_number: string;
  gender: "m" | "f";
  title: "mr" | "ms" | "mrs" | "miss" | "dr";
}

export const SANDBOX_TRAVELER: SandboxTraveler = {
  given_name: "Ada",
  family_name: "Lovelace",
  born_on: "1990-12-10",
  email: "sandbox-traveler@intyr.dev",
  phone_number: "+442080160508",
  gender: "f",
  title: "ms",
};

/** Deterministic fault selection for simulated suppliers. */
export interface SimulationDirective {
  scenario: SimScenario;
  seed: string;
}

export const SIM_SCENARIOS = [
  "HAPPY",
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
export type SimScenario = (typeof SIM_SCENARIOS)[number];

export interface ComponentRequest {
  component_id: string;
  type: ComponentType;
  /** FLIGHT and GROUND: IATA codes or place labels. */
  origin?: string;
  destination?: string;
  /** YYYY-MM-DD */
  depart_date?: string;
  /** HOTEL */
  check_in?: string;
  check_out?: string;
  hotel_ids?: string[];
  adults: number;
  currency: string;
  max_price_minor?: number;
  /** Ask for a supplier hold when the offer allows one. Off by default (Duffel agreement 2.5(j)). */
  hold?: boolean;
  /** Pin a known supplier offer instead of searching. */
  offer_id?: string;
  sim?: SimulationDirective;
}

/** A leg the caller already obtained from a supplier. Intyr cannot verify it and marks it CALLER_ASSERTED. */
export interface CallerSuppliedLeg {
  component_id: string;
  type: ComponentType;
  supplier: string;
  offer_id: string;
  price: Money;
  hold_type?: "HARD" | "SOFT" | "NONE";
  refundable?: boolean;
  requires_instant_payment?: boolean;
  price_guarantee_expires_at?: string | null;
  payment_required_by?: string | null;
  expires_at?: string | null;
  free_cancel_until?: string | null;
  void_until?: string | null;
  confirmation_mode?: ConfirmationMode;
  last_error?: string | null;
}

export interface SupplierRefs {
  offer_id: string | null;
  hold_order_id: string | null;
  prebook_id: string | null;
  booking_id: string | null;
  booking_reference: string | null;
  passenger_ids: string[];
}

export interface PreparedLeg {
  component_id: string;
  type: ComponentType;
  adapter_id: AdapterId;
  provider_id: string;
  adapter_version: string;
  leg_class: LegClass;
  evidence_grade: EvidenceGrade;
  supplier_environment: SupplierEnvironment;
  preparation_mode: PreparationMode;
  refs: SupplierRefs;
  price: Money;
  clocks: ComponentClocks;
  irreversible: boolean;
  /** Plain text built from templates. Supplier-authored text lives only in `untrusted_notes`. */
  summary: string;
  untrusted_notes: string[];
  prepared_at: string;
  request_hash: string;
  response_hash: string;
  sim: SimulationDirective | null;
}

export type PrepareResult =
  | { ok: true; leg: PreparedLeg }
  | { ok: false; reason: PrepareFailure; detail: string; retryable: boolean };

export type PrepareFailure = "NO_OFFER" | "OVER_BUDGET" | "UNSUPPORTED" | "SUPPLIER_ERROR" | "NOT_CONFIGURED" | "INVALID_REQUEST";

export interface RevalidateResult {
  status: "UNCHANGED" | "PRICE_CHANGED" | "UNAVAILABLE" | "UNKNOWN";
  leg: PreparedLeg;
  previous_price: Money;
  checked_at: string;
  response_hash: string | null;
  detail: string | null;
}

export interface CommitRequest {
  leg: PreparedLeg;
  operation_id: string;
  /** Stable per (trip, component). Sent to the supplier where it supports one. */
  idempotency_ref: string;
  max_total: Money;
  traveler: SandboxTraveler;
}

/**
 * What the supplier said about the write. RESPONDED_CONFIRMED is still only a
 * claim until `postcondition` confirms it through a read.
 */
export type CommitResponse =
  | "RESPONDED_CONFIRMED"
  | "RESPONDED_ACCEPTED"
  | "REJECTED"
  | "UNKNOWN";

export interface CommitResult {
  response: CommitResponse;
  /** True only when the supplier documents that no booking exists after this response. */
  no_booking_certain: boolean;
  refs: SupplierRefs;
  price: Money | null;
  supplier_status: string | null;
  error_code: string | null;
  detail: string | null;
  responded_at: string;
  response_hash: string | null;
}

export interface PostconditionResult {
  found: "PRESENT" | "ABSENT" | "UNKNOWN";
  confirmed: boolean;
  cancelled: boolean;
  refs: SupplierRefs;
  price: Money | null;
  supplier_status: string | null;
  /** True when ABSENT is final: negative confirmation is supported and the visibility lag has passed. */
  absent_is_final: boolean;
  evidence_tier: EvidenceTier;
  read_at: string;
  response_hash: string | null;
  detail: string | null;
}

export interface CancelQuote {
  refund: Money | null;
  fee: Money | null;
  refund_destination: RefundDestination;
  certainty: RefundAmountCertainty;
  valid_until: string | null;
  cancellable: boolean;
  detail: string | null;
}

export interface CancelResult {
  outcome: "CANCELLED" | "CANCELLED_WITH_CHARGES" | "REFUSED" | "UNKNOWN";
  refund: Money | null;
  fee: Money | null;
  refund_destination: RefundDestination;
  responded_at: string;
  response_hash: string | null;
  detail: string | null;
}

export interface IntyrAdapter {
  metadata(): AdapterMetadata;
  capabilities(): AdapterCapabilities;
  prepare(req: ComponentRequest): Promise<PrepareResult>;
  revalidate(leg: PreparedLeg): Promise<RevalidateResult>;
  commit(req: CommitRequest): Promise<CommitResult>;
  /** Independent read after a write. The only path to CONFIRMED. */
  postcondition(leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult>;
  /** Looks a booking up by Intyr's own reference after a lost response. */
  reconcileByReference(leg: PreparedLeg, idempotencyRef: string): Promise<PostconditionResult>;
  quoteCancellation(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelQuote>;
  cancel(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelResult>;
}

export interface AdapterClock {
  now(): Date;
}

export const SYSTEM_CLOCK: AdapterClock = { now: () => new Date() };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
