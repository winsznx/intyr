import {
  SANDBOX_TRAVELER,
  SYSTEM_CLOCK,
  type AdapterCapabilities,
  type AdapterClock,
  type AdapterMetadata,
  type CancelQuote,
  type CancelResult,
  type CommitRequest,
  type CommitResult,
  type ComponentClocks,
  type ComponentRequest,
  type FetchLike,
  type IntyrAdapter,
  type Money,
  type PostconditionResult,
  type PreparationMode,
  type PreparedLeg,
  type PrepareResult,
  type RevalidateResult,
  type SupplierRefs,
} from "./contract";
import {
  arr,
  emptyRefs,
  fetchJson,
  hashJson,
  iso,
  rec,
  str,
  SupplierTimeoutError,
  toDecimal,
  toMoney,
  unknownClocks,
  untrusted,
  type JsonResponse,
} from "./util";

/**
 * Duffel Flights (test mode). Docs: https://duffel.com/docs/api
 *
 * Supplier facts this adapter relies on (see internal research R2):
 * - Holds exist only for offers with payment_requirements.requires_instant_payment=false.
 *   Duffel's agreement (2.5(j)) forbids repeat holds without booking, so prepare
 *   revalidates by default and holds only when the request asks for it.
 * - There is no idempotency header. After an uncertain write, reconcile with
 *   GET /air/orders?offer_id= before anything else.
 * - 200 means "not yet created, may show up for hours", 202 means accepted and
 *   "you should not retry", 503 means no booking was created.
 */

const VERSION = "1.0.0";
const BASE_URL = "https://api.duffel.com";
const COMMIT_TIMEOUT_MS = 130_000;
const READ_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 65_000;

/** Duffel error codes after which the supplier has created nothing. */
const DEFINITE_REJECTIONS = new Set([
  "offer_no_longer_available",
  "offer_expired",
  "price_changed",
  "payment_declined",
  "insufficient_balance",
  "schedule_changed",
  "validation_required",
  "invalid_passenger_name",
  "invalid_phone_number",
  "not_valid_with_selected_offer",
  "payments_not_allowed_for_order_type",
  "services_not_allowed_for_order_type",
  "order_not_created",
  "high_fraud_risk",
]);

/** Codes that mean a booking may already exist. */
const MAYBE_BOOKED = new Set(["duplicate_booking", "order_creation_already_attempted"]);

export interface DuffelOptions {
  token: string | undefined;
  fetch?: FetchLike;
  clock?: AdapterClock;
  /** R0 refuses live tokens so no real money can move by accident. */
  allowLive?: boolean;
  baseUrl?: string;
}

interface DuffelError {
  code: string | null;
  message: string | null;
}

/** Whole years between a date of birth and the travel date, as airlines count age. */
export function ageOn(bornOn: string, travelDate: string): number {
  const born = new Date(`${bornOn}T00:00:00Z`);
  const on = new Date(`${travelDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday = on.getUTCMonth() < born.getUTCMonth() || (on.getUTCMonth() === born.getUTCMonth() && on.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function firstError(body: unknown): DuffelError {
  const err = rec(arr(rec(body).errors)[0]);
  return { code: str(err.code), message: str(err.message) ?? str(err.title) };
}

function offerClocks(offer: Record<string, unknown>, hold: boolean): { clocks: ComponentClocks; irreversible: boolean; mode: PreparationMode } {
  const req = rec(offer.payment_requirements);
  const refund = rec(rec(offer.conditions).refund_before_departure);
  const refundAllowed = refund.allowed === true;
  const conditionsKnown = typeof refund.allowed === "boolean";
  const priceGuarantee = str(req.price_guarantee_expires_at);
  const paymentBy = str(req.payment_required_by);
  const instantOnly = req.requires_instant_payment === true;
  let mode: PreparationMode = instantOnly ? "INSTANT_COMMIT_ONLY" : "REVALIDATED";
  if (hold && !instantOnly) mode = priceGuarantee ? "HARD_HOLD" : "SOFT_HOLD";
  return {
    mode,
    irreversible: !refundAllowed,
    clocks: unknownClocks({
      price_valid_until: hold && priceGuarantee ? priceGuarantee : str(offer.expires_at),
      inventory_held_until: hold && !instantOnly ? paymentBy : null,
      refund_destination: conditionsKnown ? (refundAllowed ? "UNKNOWN" : "NONE") : "UNKNOWN",
      refund_amount_certainty: refundAllowed ? "ESTIMATED" : conditionsKnown ? "QUOTED" : "UNKNOWN",
      confirmation_mode: "INSTANT",
      supplier_can_cancel: true,
    }),
  };
}

export class DuffelFlightsAdapter implements IntyrAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly clock: AdapterClock;
  private readonly baseUrl: string;

  constructor(private readonly options: DuffelOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  private get environment(): "TEST" | "LIVE" {
    return this.options.token?.startsWith("duffel_test_") ? "TEST" : "LIVE";
  }

  private get unconfiguredReason(): string | null {
    if (!this.options.token) return "DUFFEL_TOKEN is not set";
    if (this.environment === "LIVE" && !this.options.allowLive) return "live Duffel tokens are refused in this release";
    return null;
  }

  metadata(): AdapterMetadata {
    const reason = this.unconfiguredReason;
    return {
      adapter_id: "duffel-flights",
      provider_id: "duffel",
      version: VERSION,
      component_types: ["FLIGHT"],
      leg_class: "SUPPLIER_SANDBOX",
      evidence_grade: this.environment === "TEST" ? "SUPPLIER_SANDBOX" : "SUPPLIER_PRODUCTION",
      supplier_environment: this.environment,
      configured: reason === null,
      unconfigured_reason: reason,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      preparation_modes: ["HARD_HOLD", "SOFT_HOLD", "REVALIDATED", "INSTANT_COMMIT_ONLY"],
      supports_hold: true,
      supports_cancel: true,
      cancel_quote: "SUPPLIER",
      commit_idempotency: "NONE",
      status_lookup: "BY_SEARCH",
      negative_confirmation: false,
      visibility_lag_seconds: 0,
      duplicate_sweep: true,
      commit_timeout_ms: COMMIT_TIMEOUT_MS,
    };
  }

  async prepare(req: ComponentRequest): Promise<PrepareResult> {
    const reason = this.unconfiguredReason;
    if (reason) return { ok: false, reason: "NOT_CONFIGURED", detail: reason, retryable: false };
    if (req.type !== "FLIGHT") return { ok: false, reason: "UNSUPPORTED", detail: "duffel-flights serves FLIGHT only", retryable: false };

    let offer: Record<string, unknown> | null;
    let requestBody: unknown;
    try {
      if (req.offer_id) {
        requestBody = { offer_id: req.offer_id };
        const res = await this.call("GET", `/air/offers/${encodeURIComponent(req.offer_id)}`, undefined, READ_TIMEOUT_MS);
        offer = res.status === 200 ? rec(rec(res.body).data) : null;
      } else {
        if (!req.origin || !req.destination || !req.depart_date) {
          return { ok: false, reason: "INVALID_REQUEST", detail: "origin, destination and depart_date are required", retryable: false };
        }
        requestBody = {
          data: {
            slices: [{ origin: req.origin, destination: req.destination, departure_date: req.depart_date }],
            // Duffel checks the searched age against the traveler's date of birth at booking time.
            passengers: Array.from({ length: Math.max(1, req.adults) }, () => ({ age: ageOn(SANDBOX_TRAVELER.born_on, req.depart_date!) })),
            cabin_class: "economy",
            max_connections: 1,
          },
        };
        const res = await this.call("POST", "/air/offer_requests?return_offers=true&supplier_timeout=20000", requestBody, SEARCH_TIMEOUT_MS);
        if (res.status !== 201 && res.status !== 200) {
          const err = firstError(res.body);
          return { ok: false, reason: "SUPPLIER_ERROR", detail: err.message ?? `offer request failed with ${res.status}`, retryable: res.status >= 500 };
        }
        const currency = req.currency.toUpperCase();
        const returned = arr(rec(rec(res.body).data).offers).map(rec);
        const inCurrency = returned.filter((o) => str(o.total_currency) === currency);
        if (returned.length > 0 && inCurrency.length === 0) {
          const currencies = [...new Set(returned.map((o) => str(o.total_currency) ?? "unknown"))].join(", ");
          return { ok: false, reason: "NO_OFFER", detail: `Duffel priced every offer in ${currencies}, none in ${currency}`, retryable: false };
        }
        const offers = inCurrency
          .filter((o) => req.max_price_minor === undefined || toMoney(String(o.total_amount), currency).amount_minor <= req.max_price_minor)
          .sort((a, b) => Number.parseFloat(String(a.total_amount)) - Number.parseFloat(String(b.total_amount)));
        offer = offers[0] ?? null;
        if (!offer && inCurrency.length > 0) {
          return { ok: false, reason: "OVER_BUDGET", detail: `no ${currency} offer within the price cap`, retryable: false };
        }
      }
    } catch (err) {
      return { ok: false, reason: "SUPPLIER_ERROR", detail: err instanceof Error ? err.message : "supplier call failed", retryable: true };
    }
    if (!offer || !str(offer.id)) return { ok: false, reason: "NO_OFFER", detail: "no bookable offer returned", retryable: true };

    const wantsHold = req.hold === true && rec(offer.payment_requirements).requires_instant_payment === false;
    const { clocks, irreversible, mode } = offerClocks(offer, false);
    const passengerIds = arr(offer.passengers).map((p) => str(rec(p).id)).filter((id): id is string => id !== null);
    const price = toMoney(String(offer.total_amount), String(offer.total_currency));
    const owner = rec(offer.owner);
    let leg: PreparedLeg = {
      component_id: req.component_id,
      type: "FLIGHT",
      adapter_id: "duffel-flights",
      provider_id: "duffel",
      adapter_version: VERSION,
      leg_class: "SUPPLIER_SANDBOX",
      evidence_grade: this.environment === "TEST" ? "SUPPLIER_SANDBOX" : "SUPPLIER_PRODUCTION",
      supplier_environment: this.environment,
      preparation_mode: mode,
      refs: emptyRefs({ offer_id: str(offer.id), passenger_ids: passengerIds }),
      price,
      clocks,
      irreversible,
      summary: `Flight ${req.origin ?? ""} to ${req.destination ?? ""} on ${req.depart_date ?? "the pinned offer date"}`.replace(/\s+/g, " ").trim(),
      untrusted_notes: [untrusted(owner.name, 80)].filter((n): n is string => n !== null),
      prepared_at: iso(this.clock.now()),
      request_hash: await hashJson(requestBody),
      response_hash: await hashJson(offer),
      sim: null,
    };

    if (wantsHold) {
      const held = await this.createHold(leg);
      if (held) leg = held;
    }
    return { ok: true, leg };
  }

  async revalidate(leg: PreparedLeg): Promise<RevalidateResult> {
    const checkedAt = iso(this.clock.now());
    const unknown = (detail: string): RevalidateResult => ({ status: "UNKNOWN", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: null, detail });
    try {
      if (leg.refs.hold_order_id) {
        const res = await this.call("GET", `/air/orders/${encodeURIComponent(leg.refs.hold_order_id)}`, undefined, READ_TIMEOUT_MS);
        if (res.status !== 200) return unknown(`order read failed with ${res.status}`);
        const order = rec(rec(res.body).data);
        const status = rec(order.payment_status);
        if (status.awaiting_payment !== true || str(order.cancelled_at)) {
          return { status: "UNAVAILABLE", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: await hashJson(order), detail: "hold released or cancelled" };
        }
        const price = toMoney(String(order.total_amount), String(order.total_currency));
        const updated: PreparedLeg = {
          ...leg,
          price,
          clocks: {
            ...leg.clocks,
            price_valid_until: str(status.price_guarantee_expires_at) ?? leg.clocks.price_valid_until,
            inventory_held_until: str(status.payment_required_by) ?? leg.clocks.inventory_held_until,
          },
        };
        return {
          status: price.amount_minor === leg.price.amount_minor ? "UNCHANGED" : "PRICE_CHANGED",
          leg: updated,
          previous_price: leg.price,
          checked_at: checkedAt,
          response_hash: await hashJson(order),
          detail: null,
        };
      }
      if (!leg.refs.offer_id) return unknown("leg has no offer id");
      const res = await this.call("GET", `/air/offers/${encodeURIComponent(leg.refs.offer_id)}`, undefined, READ_TIMEOUT_MS);
      if (res.status === 404 || res.status === 422) {
        return { status: "UNAVAILABLE", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: await hashJson(res.body), detail: firstError(res.body).code ?? "offer gone" };
      }
      if (res.status !== 200) return unknown(`offer read failed with ${res.status}`);
      const offer = rec(rec(res.body).data);
      const price = toMoney(String(offer.total_amount), String(offer.total_currency));
      const { clocks, irreversible } = offerClocks(offer, false);
      return {
        status: price.amount_minor === leg.price.amount_minor ? "UNCHANGED" : "PRICE_CHANGED",
        leg: { ...leg, price, clocks: { ...clocks, inventory_held_until: leg.clocks.inventory_held_until }, irreversible },
        previous_price: leg.price,
        checked_at: checkedAt,
        response_hash: await hashJson(offer),
        detail: null,
      };
    } catch (err) {
      return unknown(err instanceof Error ? err.message : "supplier call failed");
    }
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const respondedAt = (): string => iso(this.clock.now());
    const reason = this.unconfiguredReason;
    if (reason) {
      return { response: "REJECTED", no_booking_certain: true, refs: req.leg.refs, price: null, supplier_status: null, error_code: "not_configured", detail: reason, responded_at: respondedAt(), response_hash: null };
    }
    if (req.leg.price.amount_minor > req.max_total.amount_minor) {
      return { response: "REJECTED", no_booking_certain: true, refs: req.leg.refs, price: null, supplier_status: null, error_code: "over_max_total", detail: "leg price exceeds the committed maximum", responded_at: respondedAt(), response_hash: null };
    }
    const payment = { type: "balance", currency: req.leg.price.currency, amount: toDecimal(req.leg.price) };
    let res: JsonResponse;
    try {
      if (req.leg.refs.hold_order_id) {
        res = await this.call("POST", "/air/payments", { data: { order_id: req.leg.refs.hold_order_id, payment } }, COMMIT_TIMEOUT_MS);
      } else {
        res = await this.call(
          "POST",
          "/air/orders",
          {
            data: {
              type: "instant",
              selected_offers: [req.leg.refs.offer_id],
              passengers: this.passengers(req),
              payments: [payment],
              metadata: { intyr_operation_id: req.operation_id, intyr_idempotency_ref: req.idempotency_ref },
            },
          },
          COMMIT_TIMEOUT_MS,
        );
      }
    } catch (err) {
      const detail = err instanceof SupplierTimeoutError ? "supplier did not answer before the timeout" : "network error during commit";
      return { response: "UNKNOWN", no_booking_certain: false, refs: req.leg.refs, price: null, supplier_status: null, error_code: "timeout", detail, responded_at: respondedAt(), response_hash: null };
    }
    return this.mapCommitResponse(req, res, respondedAt());
  }

  async postcondition(leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult> {
    const orderId = refs.booking_id ?? refs.hold_order_id;
    if (!orderId) return this.reconcileByReference(leg, "");
    try {
      const res = await this.call("GET", `/air/orders/${encodeURIComponent(orderId)}`, undefined, READ_TIMEOUT_MS);
      if (res.status === 404) return this.read("UNKNOWN", refs, null, "order id not found; Duffel may still be creating it");
      if (res.status !== 200) return this.read("UNKNOWN", refs, null, `order read failed with ${res.status}`);
      return this.orderResult(rec(rec(res.body).data), refs, await hashJson(res.body));
    } catch (err) {
      return this.read("UNKNOWN", refs, null, err instanceof Error ? err.message : "supplier call failed");
    }
  }

  /**
   * Finds our order among the orders for the offer: the hold order by id, an
   * instant order by the idempotency ref written into its metadata at commit.
   * With no ref (a postcondition right after a lost response) any order for
   * the offer counts. More than one match is a possible duplicate, so it stays
   * UNKNOWN instead of confirming whichever order Duffel listed first.
   */
  async reconcileByReference(leg: PreparedLeg, idempotencyRef: string): Promise<PostconditionResult> {
    if (!leg.refs.offer_id) return this.read("UNKNOWN", leg.refs, null, "no offer id to search by");
    try {
      const res = await this.call("GET", `/air/orders?offer_id=${encodeURIComponent(leg.refs.offer_id)}&limit=10`, undefined, READ_TIMEOUT_MS);
      if (res.status !== 200) return this.read("UNKNOWN", leg.refs, null, `order search failed with ${res.status}`);
      const orders = arr(rec(res.body).data).map(rec);
      const holdOrderId = leg.refs.hold_order_id;
      const ours = orders.filter((o) => {
        if (holdOrderId) return str(o.id) === holdOrderId;
        return idempotencyRef === "" || str(rec(o.metadata).intyr_idempotency_ref) === idempotencyRef;
      });
      if (ours.length === 0) {
        // Duffel documents that a created order can take hours to appear, so absence is never final here.
        const others = orders.length > 0 ? `; ${orders.length} order(s) for this offer carry another reference` : "";
        return this.read("UNKNOWN", leg.refs, null, `no order with this reference is visible yet${others}`);
      }
      if (ours.length > 1) {
        const ids = ours.map((o) => str(o.id) ?? "?").join(", ");
        return this.read("UNKNOWN", leg.refs, null, `${ours.length} orders match this reference (${ids}); not choosing one`);
      }
      return await this.orderResult(ours[0]!, leg.refs, await hashJson(res.body));
    } catch (err) {
      return this.read("UNKNOWN", leg.refs, null, err instanceof Error ? err.message : "supplier call failed");
    }
  }

  async quoteCancellation(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelQuote> {
    const orderId = refs.booking_id ?? refs.hold_order_id;
    const none = (detail: string): CancelQuote => ({ refund: null, fee: null, refund_destination: "UNKNOWN", certainty: "UNKNOWN", valid_until: null, cancellable: false, detail });
    if (!orderId) return none("no order to cancel");
    try {
      const res = await this.call("POST", "/air/order_cancellations", { data: { order_id: orderId } }, READ_TIMEOUT_MS);
      if (res.status !== 201 && res.status !== 200) return none(firstError(res.body).code ?? `cancellation quote failed with ${res.status}`);
      return this.quoteFrom(rec(rec(res.body).data), leg.price);
    } catch (err) {
      return none(err instanceof Error ? err.message : "supplier call failed");
    }
  }

  async cancel(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelResult> {
    const respondedAt = (): string => iso(this.clock.now());
    const orderId = refs.booking_id ?? refs.hold_order_id;
    if (!orderId) return { outcome: "REFUSED", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: null, detail: "no order to cancel" };
    try {
      const quoteRes = await this.call("POST", "/air/order_cancellations", { data: { order_id: orderId } }, READ_TIMEOUT_MS);
      if (quoteRes.status !== 201 && quoteRes.status !== 200) {
        const err = firstError(quoteRes.body);
        const refused = err.code === "order_not_cancellable" || err.code === "already_cancelled";
        return { outcome: refused ? "REFUSED" : "UNKNOWN", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: await hashJson(quoteRes.body), detail: err.code ?? err.message };
      }
      const quote = rec(rec(quoteRes.body).data);
      const quoteId = str(quote.id);
      if (!quoteId) return { outcome: "UNKNOWN", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: null, detail: "quote has no id" };
      const confirmRes = await this.call("POST", `/air/order_cancellations/${encodeURIComponent(quoteId)}/actions/confirm`, undefined, COMMIT_TIMEOUT_MS);
      const confirmed = rec(rec(confirmRes.body).data);
      const q = this.quoteFrom(confirmRes.status === 200 ? confirmed : quote, leg.price);
      if (confirmRes.status !== 200 || !str(confirmed.confirmed_at)) {
        return { outcome: "UNKNOWN", refund: q.refund, fee: q.fee, refund_destination: q.refund_destination, responded_at: respondedAt(), response_hash: await hashJson(confirmRes.body), detail: firstError(confirmRes.body).code ?? "cancellation not confirmed" };
      }
      const charged = q.fee !== null && q.fee.amount_minor > 0;
      return { outcome: charged ? "CANCELLED_WITH_CHARGES" : "CANCELLED", refund: q.refund, fee: q.fee, refund_destination: q.refund_destination, responded_at: respondedAt(), response_hash: await hashJson(confirmed), detail: null };
    } catch (err) {
      return { outcome: "UNKNOWN", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: null, detail: err instanceof Error ? err.message : "supplier call failed" };
    }
  }

  private async createHold(leg: PreparedLeg): Promise<PreparedLeg | null> {
    try {
      const res = await this.call(
        "POST",
        "/air/orders",
        {
          data: {
            type: "hold",
            selected_offers: [leg.refs.offer_id],
            passengers: this.passengers({ leg, traveler: SANDBOX_TRAVELER }),
            metadata: { intyr_component_id: leg.component_id },
          },
        },
        COMMIT_TIMEOUT_MS,
      );
      if (res.status !== 201) return null;
      const order = rec(rec(res.body).data);
      const status = rec(order.payment_status);
      const priceGuarantee = str(status.price_guarantee_expires_at);
      return {
        ...leg,
        preparation_mode: priceGuarantee ? "HARD_HOLD" : "SOFT_HOLD",
        refs: { ...leg.refs, hold_order_id: str(order.id), booking_reference: str(order.booking_reference) },
        price: toMoney(String(order.total_amount), String(order.total_currency)),
        clocks: {
          ...leg.clocks,
          price_valid_until: priceGuarantee ?? leg.clocks.price_valid_until,
          inventory_held_until: str(status.payment_required_by),
        },
        response_hash: await hashJson(order),
      };
    } catch {
      return null;
    }
  }

  private passengers(req: Pick<CommitRequest, "leg" | "traveler">): Record<string, string>[] {
    const ids = req.leg.refs.passenger_ids.length > 0 ? req.leg.refs.passenger_ids : [""];
    return ids.map((id, i) => ({
      id,
      title: req.traveler.title,
      gender: req.traveler.gender,
      given_name: i === 0 ? req.traveler.given_name : `${req.traveler.given_name}${String.fromCharCode(65 + i)}`,
      family_name: req.traveler.family_name,
      born_on: req.traveler.born_on,
      email: req.traveler.email,
      phone_number: req.traveler.phone_number,
    }));
  }

  private async mapCommitResponse(req: CommitRequest, res: JsonResponse, respondedAt: string): Promise<CommitResult> {
    const body = rec(res.body);
    const data = rec(body.data);
    const responseHash = await hashJson(res.body);
    const base = { refs: req.leg.refs, price: null, supplier_status: null, responded_at: respondedAt, response_hash: responseHash };
    if (res.status === 201) {
      // POST /air/payments returns a payment; the order id is the hold order.
      const orderId = str(data.order_id) ?? str(data.id);
      const isPayment = req.leg.refs.hold_order_id !== null;
      return {
        ...base,
        response: "RESPONDED_CONFIRMED",
        no_booking_certain: false,
        refs: {
          ...req.leg.refs,
          booking_id: isPayment ? req.leg.refs.hold_order_id : orderId,
          booking_reference: str(data.booking_reference) ?? req.leg.refs.booking_reference,
        },
        price: data.total_amount !== undefined ? toMoney(String(data.total_amount), String(data.total_currency)) : req.leg.price,
        supplier_status: isPayment ? "PAYMENT_CREATED" : "ORDER_CREATED",
        error_code: null,
        detail: null,
      };
    }
    if (res.status === 202) {
      return { ...base, response: "RESPONDED_ACCEPTED", no_booking_certain: false, supplier_status: "ACCEPTED", error_code: null, detail: "supplier accepted the order asynchronously; do not retry" };
    }
    if (res.status === 200) {
      return { ...base, response: "UNKNOWN", no_booking_certain: false, supplier_status: "NOT_YET_CREATED", error_code: null, detail: "Duffel reports the order is not yet created" };
    }
    if (res.status === 503) {
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: "service_unavailable", detail: "Duffel reports no booking was created" };
    }
    const err = firstError(res.body);
    if (err.code && MAYBE_BOOKED.has(err.code)) {
      return { ...base, response: "UNKNOWN", no_booking_certain: false, error_code: err.code, detail: err.message };
    }
    if (res.status >= 400 && res.status < 500 && (res.status !== 409 || (err.code !== null && DEFINITE_REJECTIONS.has(err.code)))) {
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: err.code ?? `http_${res.status}`, detail: err.message };
    }
    return { ...base, response: "UNKNOWN", no_booking_certain: false, error_code: err.code ?? `http_${res.status}`, detail: err.message ?? "supplier error with unknown booking state" };
  }

  private async orderResult(order: Record<string, unknown>, refs: SupplierRefs, responseHash: string): Promise<PostconditionResult> {
    const status = rec(order.payment_status);
    const cancelled = str(order.cancelled_at) !== null;
    const bookingReference = str(order.booking_reference);
    const confirmed = !cancelled && bookingReference !== null && status.awaiting_payment !== true;
    return {
      found: "PRESENT",
      confirmed,
      cancelled,
      refs: { ...refs, booking_id: str(order.id) ?? refs.booking_id, booking_reference: bookingReference ?? refs.booking_reference },
      price: order.total_amount !== undefined ? toMoney(String(order.total_amount), String(order.total_currency)) : null,
      supplier_status: cancelled ? "CANCELLED" : status.awaiting_payment === true ? "AWAITING_PAYMENT" : "TICKETED_OR_CONFIRMED",
      absent_is_final: false,
      evidence_tier: "E1",
      read_at: iso(this.clock.now()),
      response_hash: responseHash,
      detail: null,
    };
  }

  /**
   * Duffel's cancellation has no fee field, only the refund the fare conditions
   * allow. The fee is what the leg cost minus that refund. A pay-later order
   * (refund_to awaiting_payment) was never paid, so it costs nothing to cancel.
   * Without a refund amount in the leg's currency the fee stays unknown.
   */
  private quoteFrom(q: Record<string, unknown>, paid: Money): CancelQuote {
    const refundTo = str(q.refund_to);
    const destination = refundTo === null ? "UNKNOWN" : refundTo === "airline_credits" || refundTo === "voucher" ? "CREDIT" : "CASH";
    const refund: Money | null = q.refund_amount !== null && q.refund_amount !== undefined && str(q.refund_currency)
      ? toMoney(String(q.refund_amount), String(q.refund_currency))
      : null;
    let fee: Money | null = null;
    if (refundTo === "awaiting_payment") fee = { amount_minor: 0, currency: paid.currency };
    else if (refund && refund.currency === paid.currency) fee = { amount_minor: Math.max(0, paid.amount_minor - refund.amount_minor), currency: paid.currency };
    return {
      refund,
      fee,
      refund_destination: destination,
      certainty: refund ? "QUOTED" : "UNKNOWN",
      valid_until: str(q.expires_at),
      cancellable: true,
      detail: refundTo ? `refund_to=${refundTo}` : null,
    };
  }

  private read(found: PostconditionResult["found"], refs: SupplierRefs, price: Money | null, detail: string): PostconditionResult {
    return {
      found,
      confirmed: false,
      cancelled: false,
      refs,
      price,
      supplier_status: null,
      absent_is_final: false,
      evidence_tier: "E1",
      read_at: iso(this.clock.now()),
      response_hash: null,
      detail,
    };
  }

  private call(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<JsonResponse> {
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token ?? ""}`,
          "Duffel-Version": "v2",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
  }
}
