import {
  SYSTEM_CLOCK,
  type AdapterCapabilities,
  type AdapterClock,
  type AdapterMetadata,
  type CallerSuppliedLeg,
  type CancelQuote,
  type CancelResult,
  type CommitResult,
  type ComponentType,
  type IntyrAdapter,
  type PostconditionResult,
  type PreparationMode,
  type PreparedLeg,
  type PrepareResult,
  type RevalidateResult,
  type SupplierRefs,
} from "./contract";
import { emptyRefs, hashJson, iso, unknownClocks, untrusted } from "./util";

const VERSION = "1.0.0";
const TYPES: ComponentType[] = ["FLIGHT", "HOTEL", "GROUND"];

export class CallerSuppliedLegError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "CallerSuppliedLegError";
  }
}

function isoOrNull(field: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new CallerSuppliedLegError(field, "must be an ISO 8601 timestamp");
  return new Date(t).toISOString();
}

/**
 * Maps the caller's own description of a supplier offer to a preparation mode.
 * Nothing here is verified by Intyr, so every leg carries CALLER_ASSERTED.
 */
export function callerPreparationMode(leg: CallerSuppliedLeg): PreparationMode {
  if (leg.hold_type === "HARD") return "HARD_HOLD";
  if (leg.hold_type === "SOFT") return "SOFT_HOLD";
  if (leg.requires_instant_payment === true) return "INSTANT_COMMIT_ONLY";
  if (leg.payment_required_by && leg.price_guarantee_expires_at) return "HARD_HOLD";
  if (leg.payment_required_by) return "SOFT_HOLD";
  return "REVALIDATED";
}

export function validateCallerLeg(leg: CallerSuppliedLeg): void {
  if (!leg.component_id || typeof leg.component_id !== "string") throw new CallerSuppliedLegError("component_id", "required");
  if (!TYPES.includes(leg.type)) throw new CallerSuppliedLegError("type", `must be one of ${TYPES.join(", ")}`);
  if (!leg.supplier || typeof leg.supplier !== "string") throw new CallerSuppliedLegError("supplier", "required");
  if (!leg.offer_id || typeof leg.offer_id !== "string") throw new CallerSuppliedLegError("offer_id", "required");
  if (!leg.price || !Number.isInteger(leg.price.amount_minor) || leg.price.amount_minor < 0) {
    throw new CallerSuppliedLegError("price.amount_minor", "must be a non-negative integer in minor units");
  }
  if (!/^[A-Z]{3}$/.test(leg.price.currency ?? "")) throw new CallerSuppliedLegError("price.currency", "must be an ISO 4217 code");
}

/** Builds a PreparedLeg from caller-supplied offer data. Throws CallerSuppliedLegError on invalid input. */
export async function legFromCallerSupplied(leg: CallerSuppliedLeg, clock: AdapterClock = SYSTEM_CLOCK): Promise<PreparedLeg> {
  validateCallerLeg(leg);
  const now = clock.now();
  const mode = callerPreparationMode(leg);
  const refundable = leg.refundable === true;
  const holdUntil = isoOrNull("payment_required_by", leg.payment_required_by);
  const priceUntil = isoOrNull("price_guarantee_expires_at", leg.price_guarantee_expires_at) ?? isoOrNull("expires_at", leg.expires_at);
  const supplier = untrusted(leg.supplier, 64) ?? "unknown";
  return {
    component_id: leg.component_id,
    type: leg.type,
    adapter_id: "caller-supplied",
    provider_id: `caller:${supplier}`,
    adapter_version: VERSION,
    leg_class: "CALLER_SUPPLIED",
    evidence_grade: "CALLER_ASSERTED",
    supplier_environment: "NONE",
    preparation_mode: mode,
    refs: emptyRefs({ offer_id: leg.offer_id }),
    price: { amount_minor: leg.price.amount_minor, currency: leg.price.currency },
    clocks: unknownClocks({
      price_valid_until: priceUntil,
      inventory_held_until: mode === "HARD_HOLD" || mode === "SOFT_HOLD" ? holdUntil : null,
      free_cancel_until: isoOrNull("free_cancel_until", leg.free_cancel_until),
      void_until: isoOrNull("void_until", leg.void_until),
      refund_destination: leg.refundable === undefined ? "UNKNOWN" : refundable ? "CASH" : "NONE",
      refund_amount_certainty: "UNKNOWN",
      confirmation_mode: leg.confirmation_mode ?? "INSTANT",
    }),
    irreversible: leg.refundable !== true && !leg.void_until && !leg.free_cancel_until,
    summary: `Caller-supplied ${leg.type.toLowerCase()} from ${supplier}`,
    untrusted_notes: [untrusted(leg.last_error)].filter((n): n is string => n !== null),
    prepared_at: iso(now),
    request_hash: await hashJson(leg),
    response_hash: await hashJson(leg),
    sim: null,
  };
}

/**
 * The caller executes caller-supplied legs itself. Intyr plans, orders and
 * records them but never writes to their supplier, so every write is refused
 * with a definite "no booking" and every read is UNKNOWN.
 */
export class CallerSuppliedAdapter implements IntyrAdapter {
  constructor(private readonly clock: AdapterClock = SYSTEM_CLOCK) {}

  metadata(): AdapterMetadata {
    return {
      adapter_id: "caller-supplied",
      provider_id: "caller",
      version: VERSION,
      component_types: TYPES,
      leg_class: "CALLER_SUPPLIED",
      evidence_grade: "CALLER_ASSERTED",
      supplier_environment: "NONE",
      configured: true,
      unconfigured_reason: null,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      preparation_modes: ["HARD_HOLD", "SOFT_HOLD", "REVALIDATED", "INSTANT_COMMIT_ONLY"],
      supports_hold: false,
      supports_cancel: false,
      cancel_quote: "NONE",
      commit_idempotency: "NONE",
      status_lookup: "NONE",
      negative_confirmation: false,
      visibility_lag_seconds: 0,
      duplicate_sweep: false,
      commit_timeout_ms: 0,
    };
  }

  async prepare(): Promise<PrepareResult> {
    return { ok: false, reason: "UNSUPPORTED", detail: "caller-supplied legs are built with legFromCallerSupplied", retryable: false };
  }

  async revalidate(leg: PreparedLeg): Promise<RevalidateResult> {
    return { status: "UNKNOWN", leg, previous_price: leg.price, checked_at: iso(this.clock.now()), response_hash: null, detail: "Intyr cannot read the caller's supplier" };
  }

  async commit(): Promise<CommitResult> {
    return {
      response: "REJECTED",
      no_booking_certain: true,
      refs: emptyRefs(),
      price: null,
      supplier_status: null,
      error_code: "caller_executes",
      detail: "the caller books caller-supplied legs itself",
      responded_at: iso(this.clock.now()),
      response_hash: null,
    };
  }

  async postcondition(_leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult> {
    return this.unknownRead(refs);
  }

  async reconcileByReference(leg: PreparedLeg): Promise<PostconditionResult> {
    return this.unknownRead(leg.refs);
  }

  async quoteCancellation(): Promise<CancelQuote> {
    return { refund: null, fee: null, refund_destination: "UNKNOWN", certainty: "UNKNOWN", valid_until: null, cancellable: false, detail: "the caller cancels caller-supplied legs itself" };
  }

  async cancel(): Promise<CancelResult> {
    return { outcome: "REFUSED", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: iso(this.clock.now()), response_hash: null, detail: "the caller cancels caller-supplied legs itself" };
  }

  private unknownRead(refs: SupplierRefs): PostconditionResult {
    return {
      found: "UNKNOWN",
      confirmed: false,
      cancelled: false,
      refs,
      price: null,
      supplier_status: null,
      absent_is_final: false,
      evidence_tier: "E1",
      read_at: iso(this.clock.now()),
      response_hash: null,
      detail: "Intyr has no read path to the caller's supplier",
    };
  }
}
