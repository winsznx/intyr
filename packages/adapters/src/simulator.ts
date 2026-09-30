import { sha256Hex } from "@intyr/core";

import {
  SYSTEM_CLOCK,
  type AdapterCapabilities,
  type AdapterClock,
  type AdapterId,
  type AdapterMetadata,
  type CancelQuote,
  type CancelResult,
  type CommitRequest,
  type CommitResult,
  type ComponentRequest,
  type ComponentType,
  type IntyrAdapter,
  type Money,
  type PostconditionResult,
  type PreparedLeg,
  type PrepareResult,
  type RevalidateResult,
  type SimScenario,
  type SimulationDirective,
  type SupplierRefs,
} from "./contract";
import { emptyRefs, hashJson, iso, unknownClocks } from "./util";

/**
 * Seeded hostile supplier. Every fault is chosen by the caller-visible
 * (scenario, seed) pair before the run, so a run can be replayed exactly and an
 * auditor can read the supplier-side order list without touching Intyr's store.
 *
 * Like Duffel, the simulator has no commit idempotency: calling commit twice
 * creates two orders. Safety has to come from reconcile-before-retry.
 */

export interface SimulatorStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class MemorySimulatorStore implements SimulatorStore {
  private readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

export type SimOrderStatus = "CONFIRMED" | "PENDING" | "FAILED" | "CANCELLED";

export interface SimOrder {
  booking_id: string;
  booking_reference: string;
  component_id: string;
  offer_id: string;
  idempotency_ref: string;
  operation_id: string;
  status: SimOrderStatus;
  /** Status the order moves to once `settles_at` passes (async suppliers). */
  settles_to: SimOrderStatus | null;
  settles_at: string | null;
  price: Money;
  created_at: string;
  visible_at: string;
  cancelled_at: string | null;
  refund: Money | null;
}

interface SimOffer {
  offer_id: string;
  component_id: string;
  type: ComponentType;
  scenario: SimScenario;
  price: Money;
  prepared_at: string;
  revalidations: number;
}

interface SimAttempt {
  idempotency_ref: string;
  offer_id: string;
  at: string;
  count: number;
}

interface SimState {
  offers: Record<string, SimOffer>;
  orders: SimOrder[];
  attempts: Record<string, SimAttempt>;
}

export interface SimulatorOptions {
  adapterId: Extract<AdapterId, "sim-hostile" | "sim-ground">;
  store: SimulatorStore;
  clock?: AdapterClock;
  visibilityLagSeconds?: number;
  componentTypes?: ComponentType[];
}

const VERSION = "1.0.0";
const PRICE_BANDS: Record<ComponentType, [number, number]> = {
  FLIGHT: [18_000, 42_000],
  HOTEL: [9_000, 26_000],
  GROUND: [2_500, 8_000],
};

async function seededInt(seed: string, label: string, min: number, max: number): Promise<number> {
  const hex = await sha256Hex(`${seed}:${label}`);
  const n = Number.parseInt(hex.slice(0, 8), 16);
  return min + (n % (max - min + 1));
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function isRefundable(scenario: SimScenario): boolean {
  return scenario !== "NON_REFUNDABLE";
}

export class SimulatorAdapter implements IntyrAdapter {
  private readonly clock: AdapterClock;
  private readonly lag: number;
  private readonly types: ComponentType[];

  constructor(private readonly options: SimulatorOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.lag = options.visibilityLagSeconds ?? 2;
    this.types = options.componentTypes ?? (options.adapterId === "sim-ground" ? ["GROUND"] : ["FLIGHT", "HOTEL", "GROUND"]);
  }

  metadata(): AdapterMetadata {
    return {
      adapter_id: this.options.adapterId,
      provider_id: "intyr-simulator",
      version: VERSION,
      component_types: this.types,
      leg_class: "SIMULATED",
      evidence_grade: "SIMULATED",
      supplier_environment: "NONE",
      configured: true,
      unconfigured_reason: null,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      preparation_modes: ["HARD_HOLD", "REVALIDATED"],
      supports_hold: true,
      supports_cancel: true,
      cancel_quote: "COMPUTED",
      commit_idempotency: "NONE",
      status_lookup: "BY_SEARCH",
      negative_confirmation: true,
      visibility_lag_seconds: this.lag,
      duplicate_sweep: true,
      commit_timeout_ms: 5_000,
    };
  }

  /** Supplier-side ground truth for independent auditors. Never used by the commit kernel. */
  async auditOrders(seed: string): Promise<SimOrder[]> {
    const state = await this.load(seed);
    const now = this.clock.now();
    return state.orders.map((o) => this.settle(o, now));
  }

  async prepare(req: ComponentRequest): Promise<PrepareResult> {
    if (!this.types.includes(req.type)) {
      return { ok: false, reason: "UNSUPPORTED", detail: `simulator does not serve ${req.type}`, retryable: false };
    }
    const directive: SimulationDirective = req.sim ?? { scenario: "HAPPY", seed: req.component_id };
    const [min, max] = PRICE_BANDS[req.type];
    const amount = await seededInt(directive.seed, `price:${req.component_id}`, min, max);
    const price: Money = { amount_minor: amount, currency: req.currency.toUpperCase() };
    if (req.max_price_minor !== undefined && amount > req.max_price_minor) {
      return { ok: false, reason: "OVER_BUDGET", detail: `cheapest simulated offer ${amount} exceeds ${req.max_price_minor}`, retryable: false };
    }

    const now = this.clock.now();
    const offerId = `sim_off_${(await sha256Hex(`${directive.seed}:${req.component_id}`)).slice(0, 16)}`;
    const state = await this.load(directive.seed);
    state.offers[offerId] = {
      offer_id: offerId,
      component_id: req.component_id,
      type: req.type,
      scenario: directive.scenario,
      price,
      prepared_at: iso(now),
      revalidations: 0,
    };
    await this.save(directive.seed, state);

    const hold = req.hold === true;
    const heldUntil = directive.scenario === "HOLD_EXPIRY" ? addSeconds(now, -1) : addSeconds(now, 20 * 60);
    const refundable = isRefundable(directive.scenario);
    const leg: PreparedLeg = {
      component_id: req.component_id,
      type: req.type,
      adapter_id: this.options.adapterId,
      provider_id: "intyr-simulator",
      adapter_version: VERSION,
      leg_class: "SIMULATED",
      evidence_grade: "SIMULATED",
      supplier_environment: "NONE",
      preparation_mode: hold ? "HARD_HOLD" : "REVALIDATED",
      refs: emptyRefs({ offer_id: offerId, hold_order_id: hold ? `sim_hold_${offerId.slice(8)}` : null }),
      price,
      clocks: unknownClocks({
        price_valid_until: iso(addSeconds(now, 30 * 60)),
        inventory_held_until: hold ? iso(heldUntil) : null,
        free_cancel_until: refundable ? iso(addSeconds(now, 48 * 3600)) : null,
        refund_destination: refundable ? "CASH" : "NONE",
        refund_amount_certainty: "QUOTED",
        confirmation_mode: directive.scenario.startsWith("ACCEPTED_ASYNC") ? "ASYNC" : "INSTANT",
      }),
      irreversible: !refundable,
      summary: `Simulated ${req.type.toLowerCase()} ${req.origin ?? req.hotel_ids?.[0] ?? ""}${req.destination ? ` to ${req.destination}` : ""}`.trim(),
      untrusted_notes: [],
      prepared_at: iso(now),
      request_hash: await hashJson(req),
      response_hash: await hashJson({ offerId, price, scenario: directive.scenario }),
      sim: directive,
    };
    return { ok: true, leg };
  }

  async revalidate(leg: PreparedLeg): Promise<RevalidateResult> {
    const now = this.clock.now();
    const seed = this.seedOf(leg);
    const state = await this.load(seed);
    const offer = leg.refs.offer_id ? state.offers[leg.refs.offer_id] : undefined;
    if (!offer) {
      return { status: "UNAVAILABLE", leg, previous_price: leg.price, checked_at: iso(now), response_hash: null, detail: "offer not found" };
    }
    offer.revalidations += 1;
    let status: RevalidateResult["status"] = "UNCHANGED";
    let updated = leg;
    if (offer.scenario === "PRICE_DIVERGENCE" && offer.revalidations === 1) {
      const newPrice: Money = { ...offer.price, amount_minor: Math.round(offer.price.amount_minor * 1.08) };
      offer.price = newPrice;
      status = "PRICE_CHANGED";
      updated = { ...leg, price: newPrice };
    }
    await this.save(seed, state);
    return {
      status,
      leg: updated,
      previous_price: leg.price,
      checked_at: iso(now),
      response_hash: await hashJson({ offer_id: offer.offer_id, price: offer.price, n: offer.revalidations }),
      detail: status === "PRICE_CHANGED" ? "supplier repriced the offer" : null,
    };
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const now = this.clock.now();
    const seed = this.seedOf(req.leg);
    const state = await this.load(seed);
    const offerId = req.leg.refs.offer_id ?? "";
    const offer = state.offers[offerId];
    const attempt = state.attempts[req.idempotency_ref] ?? { idempotency_ref: req.idempotency_ref, offer_id: offerId, at: iso(now), count: 0 };
    attempt.count += 1;
    attempt.at = iso(now);
    state.attempts[req.idempotency_ref] = attempt;

    const base = { refs: { ...req.leg.refs }, price: null, supplier_status: null, detail: null, responded_at: iso(now) };
    const reject = async (code: string, detail: string): Promise<CommitResult> => {
      await this.save(seed, state);
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: code, detail, response_hash: await hashJson({ code }) };
    };

    if (!offer) return reject("offer_not_found", "offer unknown to supplier");
    if (offer.price.amount_minor > req.max_total.amount_minor) return reject("price_changed", "offer price exceeds the committed maximum");

    const scenario = offer.scenario;
    if (scenario === "UNAVAILABLE_AT_COMMIT") return reject("offer_no_longer_available", "inventory sold out before commit");
    if (scenario === "COMMIT_REJECT") return reject("supplier_rejected", "supplier refused the booking");
    if (scenario === "HOLD_EXPIRY" && req.leg.preparation_mode === "HARD_HOLD") return reject("hold_expired", "hold expired before payment");

    const order = await this.newOrder(state, req, offer, now);

    switch (scenario) {
      case "TIMEOUT_BOOKED":
      case "DUPLICATE_ON_RETRY": {
        if (scenario === "TIMEOUT_BOOKED") order.visible_at = iso(addSeconds(now, this.lag));
        state.orders.push(order);
        await this.save(seed, state);
        return { ...base, response: "UNKNOWN", no_booking_certain: false, error_code: "timeout", detail: "no response before timeout", response_hash: null };
      }
      case "TIMEOUT_NOT_BOOKED": {
        await this.save(seed, state);
        return { ...base, response: "UNKNOWN", no_booking_certain: false, error_code: "timeout", detail: "no response before timeout", response_hash: null };
      }
      case "ACCEPTED_ASYNC_CONFIRMS":
      case "ACCEPTED_ASYNC_FAILS": {
        order.status = "PENDING";
        order.settles_to = scenario === "ACCEPTED_ASYNC_CONFIRMS" ? "CONFIRMED" : "FAILED";
        order.settles_at = iso(addSeconds(now, this.lag));
        state.orders.push(order);
        await this.save(seed, state);
        return {
          ...base,
          response: "RESPONDED_ACCEPTED",
          no_booking_certain: false,
          refs: { ...req.leg.refs, booking_id: order.booking_id },
          supplier_status: "PENDING",
          error_code: null,
          response_hash: await hashJson({ booking_id: order.booking_id, status: "PENDING" }),
        };
      }
      case "RESPONSE_OK_STATUS_DISAGREES": {
        await this.save(seed, state);
        return {
          ...base,
          response: "RESPONDED_CONFIRMED",
          no_booking_certain: false,
          refs: { ...req.leg.refs, booking_id: order.booking_id, booking_reference: order.booking_reference },
          price: offer.price,
          supplier_status: "CONFIRMED",
          error_code: null,
          response_hash: await hashJson({ booking_id: order.booking_id, status: "CONFIRMED" }),
        };
      }
      default: {
        state.orders.push(order);
        await this.save(seed, state);
        return {
          ...base,
          response: "RESPONDED_CONFIRMED",
          no_booking_certain: false,
          refs: { ...req.leg.refs, booking_id: order.booking_id, booking_reference: order.booking_reference },
          price: offer.price,
          supplier_status: "CONFIRMED",
          error_code: null,
          response_hash: await hashJson({ booking_id: order.booking_id, status: "CONFIRMED" }),
        };
      }
    }
  }

  async postcondition(leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult> {
    const now = this.clock.now();
    const state = await this.load(this.seedOf(leg));
    if (!refs.booking_id) return this.reconcileFromState(state, leg, null, now);
    const order = state.orders.find((o) => o.booking_id === refs.booking_id);
    if (!order) {
      const attempt = Object.values(state.attempts).find((a) => a.offer_id === leg.refs.offer_id);
      const lagPassed = attempt ? now.getTime() >= new Date(attempt.at).getTime() + this.lag * 1000 : true;
      return this.readResult(now, "ABSENT", null, refs, lagPassed, "no order with this booking id");
    }
    return this.orderRead(order, refs, now);
  }

  async reconcileByReference(leg: PreparedLeg, idempotencyRef: string): Promise<PostconditionResult> {
    const now = this.clock.now();
    const state = await this.load(this.seedOf(leg));
    return this.reconcileFromState(state, leg, idempotencyRef, now);
  }

  async quoteCancellation(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelQuote> {
    const state = await this.load(this.seedOf(leg));
    const order = state.orders.find((o) => o.booking_id === refs.booking_id);
    const scenario = leg.refs.offer_id ? state.offers[leg.refs.offer_id]?.scenario : undefined;
    if (!order) {
      return { refund: null, fee: null, refund_destination: "UNKNOWN", certainty: "UNKNOWN", valid_until: null, cancellable: false, detail: "no order to cancel" };
    }
    if (scenario === "CANCEL_REFUSED") {
      return { refund: null, fee: null, refund_destination: "NONE", certainty: "QUOTED", valid_until: null, cancellable: false, detail: "supplier does not accept cancellation" };
    }
    const refundable = scenario ? isRefundable(scenario) : true;
    return {
      refund: { ...order.price, amount_minor: refundable ? order.price.amount_minor : 0 },
      fee: { ...order.price, amount_minor: refundable ? 0 : order.price.amount_minor },
      refund_destination: refundable ? "CASH" : "NONE",
      certainty: "QUOTED",
      valid_until: iso(addSeconds(this.clock.now(), 15 * 60)),
      cancellable: true,
      detail: null,
    };
  }

  async cancel(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelResult> {
    const now = this.clock.now();
    const seed = this.seedOf(leg);
    const state = await this.load(seed);
    const quote = await this.quoteCancellation(leg, refs);
    const order = state.orders.find((o) => o.booking_id === refs.booking_id);
    if (!order || !quote.cancellable) {
      return { outcome: "REFUSED", refund: null, fee: null, refund_destination: quote.refund_destination, responded_at: iso(now), response_hash: null, detail: quote.detail };
    }
    order.status = "CANCELLED";
    order.settles_to = null;
    order.cancelled_at = iso(now);
    order.refund = quote.refund;
    await this.save(seed, state);
    const charged = (quote.fee?.amount_minor ?? 0) > 0;
    return {
      outcome: charged ? "CANCELLED_WITH_CHARGES" : "CANCELLED",
      refund: quote.refund,
      fee: quote.fee,
      refund_destination: quote.refund_destination,
      responded_at: iso(now),
      response_hash: await hashJson({ booking_id: order.booking_id, status: "CANCELLED" }),
      detail: null,
    };
  }

  private seedOf(leg: PreparedLeg): string {
    return leg.sim?.seed ?? leg.component_id;
  }

  private async newOrder(state: SimState, req: CommitRequest, offer: SimOffer, now: Date): Promise<SimOrder> {
    const n = state.orders.length + 1;
    const digest = await sha256Hex(`${req.idempotency_ref}:${n}`);
    return {
      booking_id: `sim_bk_${digest.slice(0, 12)}`,
      booking_reference: digest.slice(12, 18).toUpperCase(),
      component_id: offer.component_id,
      offer_id: offer.offer_id,
      idempotency_ref: req.idempotency_ref,
      operation_id: req.operation_id,
      status: "CONFIRMED",
      settles_to: null,
      settles_at: null,
      price: offer.price,
      created_at: iso(now),
      visible_at: iso(now),
      cancelled_at: null,
      refund: null,
    };
  }

  private settle(order: SimOrder, now: Date): SimOrder {
    if (order.settles_to && order.settles_at && now.getTime() >= new Date(order.settles_at).getTime()) {
      return { ...order, status: order.settles_to, settles_to: null };
    }
    return order;
  }

  private reconcileFromState(state: SimState, leg: PreparedLeg, idempotencyRef: string | null, now: Date): PostconditionResult {
    const matches = state.orders.filter(
      (o) => (idempotencyRef ? o.idempotency_ref === idempotencyRef : o.offer_id === leg.refs.offer_id) && now >= new Date(o.visible_at),
    );
    if (matches.length > 0) {
      const live = matches.find((o) => this.settle(o, now).status !== "CANCELLED") ?? matches[0]!;
      return this.orderRead(live, { ...leg.refs, booking_id: live.booking_id, booking_reference: live.booking_reference }, now, matches.length);
    }
    const attempt = idempotencyRef
      ? state.attempts[idempotencyRef]
      : Object.values(state.attempts).find((a) => a.offer_id === leg.refs.offer_id);
    const lagPassed = attempt ? now.getTime() >= new Date(attempt.at).getTime() + this.lag * 1000 : true;
    return this.readResult(now, "ABSENT", null, leg.refs, lagPassed, attempt ? "no visible order for this reference" : "no commit attempt recorded");
  }

  private orderRead(raw: SimOrder, refs: SupplierRefs, now: Date, matchCount = 1): PostconditionResult {
    const order = this.settle(raw, now);
    if (now < new Date(order.visible_at)) {
      return this.readResult(now, "UNKNOWN", order, refs, false, "order not yet visible");
    }
    if (order.status === "FAILED") return this.readResult(now, "ABSENT", order, refs, true, "supplier reports the order failed");
    const detail = matchCount > 1 ? `duplicate orders found: ${matchCount}` : null;
    return {
      found: "PRESENT",
      confirmed: order.status === "CONFIRMED",
      cancelled: order.status === "CANCELLED",
      refs: { ...refs, booking_id: order.booking_id, booking_reference: order.booking_reference },
      price: order.price,
      supplier_status: order.status,
      absent_is_final: false,
      evidence_tier: "E1",
      read_at: iso(now),
      response_hash: null,
      detail,
    };
  }

  private readResult(
    now: Date,
    found: PostconditionResult["found"],
    order: SimOrder | null,
    refs: SupplierRefs,
    absentIsFinal: boolean,
    detail: string,
  ): PostconditionResult {
    return {
      found: found === "ABSENT" && !absentIsFinal ? "UNKNOWN" : found,
      confirmed: false,
      cancelled: false,
      refs,
      price: order?.price ?? null,
      supplier_status: order?.status ?? null,
      absent_is_final: found === "ABSENT" && absentIsFinal,
      evidence_tier: "E1",
      read_at: iso(now),
      response_hash: null,
      detail,
    };
  }

  private async load(seed: string): Promise<SimState> {
    const raw = await this.options.store.get(`sim:${seed}`);
    return raw ? (JSON.parse(raw) as SimState) : { offers: {}, orders: [], attempts: {} };
  }

  private async save(seed: string, state: SimState): Promise<void> {
    await this.options.store.put(`sim:${seed}`, JSON.stringify(state));
  }
}
