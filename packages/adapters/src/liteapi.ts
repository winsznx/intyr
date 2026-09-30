import {
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
  type PreparedLeg,
  type PrepareResult,
  type RevalidateResult,
  type SupplierRefs,
} from "./contract";
import { arr, emptyRefs, fetchJson, hashJson, iso, rec, str, SupplierTimeoutError, toMoney, unknownClocks, untrusted, type JsonResponse } from "./util";

/**
 * Nuitee Connect (LiteAPI) hotels, sandbox. Docs: https://docs.liteapi.travel
 *
 * Supplier facts (internal research R2):
 * - No hotel holds. Prebook revalidates price and availability; book commits.
 * - `clientReference` is an idempotency key: a second book with the same value
 *   returns error 4005 instead of a second booking.
 * - CONFIRMED at book time means Nuitee accepted it; the hotel confirmation code
 *   can arrive later through a manual process.
 */

const VERSION = "1.0.0";
const SEARCH_URL = "https://api.liteapi.travel/v3.0";
const BOOK_URL = "https://book.liteapi.travel/v3.0";
const COMMIT_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;
/** Public sandbox examples use this property. Callers should pass hotel_ids. */
const DEFAULT_HOTEL_IDS = ["lp1897"];

/** LiteAPI error codes after which no booking exists. */
const DEFINITE_REJECTIONS = new Set([2001, 4016, 4012]);
const MAYBE_BOOKED = new Set([4005, 2013, 2014, 5000, 40900]);

export interface LiteApiOptions {
  apiKey: string | undefined;
  fetch?: FetchLike;
  clock?: AdapterClock;
  allowLive?: boolean;
  searchUrl?: string;
  bookUrl?: string;
}

interface CancelPolicyInfo {
  cancelTime: string;
  amount: number;
}

/** "2025-01-01 00:00:00" in the stated timezone (GMT in examples) to ISO 8601. */
function policyTime(text: string): string | null {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text.replace(" ", "T").replace(/Z?$/, "Z");
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function clocksFromPolicies(policies: Record<string, unknown>, fallbackPriceUntil: string | null): { clocks: ComponentClocks; irreversible: boolean } {
  const tag = str(policies.refundableTag);
  const infos: CancelPolicyInfo[] = arr(policies.cancelPolicyInfos)
    .map(rec)
    .map((p) => ({ cancelTime: String(p.cancelTime ?? ""), amount: Number(p.amount ?? 0) }))
    .filter((p) => p.cancelTime.length > 0);
  const firstCharge = infos
    .filter((p) => p.amount > 0)
    .map((p) => policyTime(p.cancelTime))
    .filter((t): t is string => t !== null)
    .sort()[0];
  const refundable = tag === "RFN";
  return {
    irreversible: !refundable,
    clocks: unknownClocks({
      price_valid_until: fallbackPriceUntil,
      free_cancel_until: refundable ? firstCharge ?? null : null,
      refund_destination: tag === null ? "UNKNOWN" : refundable ? "CASH" : "NONE",
      refund_amount_certainty: infos.length > 0 ? "QUOTED" : "UNKNOWN",
      confirmation_mode: "INSTANT",
      supplier_can_cancel: true,
    }),
  };
}

function errorCode(body: unknown): { code: number | null; message: string | null } {
  const err = rec(rec(body).error);
  const code = typeof err.code === "number" ? err.code : Number.parseInt(String(err.code ?? ""), 10);
  return { code: Number.isFinite(code) ? code : null, message: str(err.message) ?? str(err.description) };
}

export class LiteApiHotelsAdapter implements IntyrAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly clock: AdapterClock;

  constructor(private readonly options: LiteApiOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  private get environment(): "TEST" | "LIVE" {
    return this.options.apiKey?.startsWith("sand_") ? "TEST" : "LIVE";
  }

  private get unconfiguredReason(): string | null {
    if (!this.options.apiKey) return "LITEAPI_KEY is not set";
    if (this.environment === "LIVE" && !this.options.allowLive) return "live LiteAPI keys are refused in this release";
    return null;
  }

  metadata(): AdapterMetadata {
    const reason = this.unconfiguredReason;
    return {
      adapter_id: "liteapi-hotels",
      provider_id: "nuitee-liteapi",
      version: VERSION,
      component_types: ["HOTEL"],
      leg_class: "SUPPLIER_SANDBOX",
      evidence_grade: this.environment === "TEST" ? "SUPPLIER_SANDBOX" : "SUPPLIER_PRODUCTION",
      supplier_environment: this.environment,
      configured: reason === null,
      unconfigured_reason: reason,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      preparation_modes: ["REVALIDATED"],
      supports_hold: false,
      supports_cancel: true,
      cancel_quote: "COMPUTED",
      commit_idempotency: "KEY",
      status_lookup: "BY_REFERENCE",
      negative_confirmation: false,
      visibility_lag_seconds: 0,
      duplicate_sweep: false,
      commit_timeout_ms: COMMIT_TIMEOUT_MS,
    };
  }

  async prepare(req: ComponentRequest): Promise<PrepareResult> {
    const reason = this.unconfiguredReason;
    if (reason) return { ok: false, reason: "NOT_CONFIGURED", detail: reason, retryable: false };
    if (req.type !== "HOTEL") return { ok: false, reason: "UNSUPPORTED", detail: "liteapi-hotels serves HOTEL only", retryable: false };
    if (!req.check_in || !req.check_out) return { ok: false, reason: "INVALID_REQUEST", detail: "check_in and check_out are required", retryable: false };

    const currency = req.currency.toUpperCase();
    const searchBody = {
      hotelIds: req.hotel_ids && req.hotel_ids.length > 0 ? req.hotel_ids : DEFAULT_HOTEL_IDS,
      occupancies: [{ adults: Math.max(1, req.adults) }],
      currency,
      guestNationality: "US",
      checkin: req.check_in,
      checkout: req.check_out,
      timeout: 8,
    };
    try {
      let offerId = req.offer_id ?? null;
      let hotelName: string | null = null;
      if (!offerId) {
        const res = await this.call("POST", `${this.options.searchUrl ?? SEARCH_URL}/hotels/rates`, searchBody, READ_TIMEOUT_MS);
        if (res.status !== 200) {
          const err = errorCode(res.body);
          if (err.code === 2001) return { ok: false, reason: "NO_OFFER", detail: "no availability for the stay", retryable: false };
          return { ok: false, reason: "SUPPLIER_ERROR", detail: err.message ?? `rates search failed with ${res.status}`, retryable: res.status >= 500 };
        }
        const candidates = arr(rec(res.body).data)
          .map(rec)
          .flatMap((hotel) =>
            arr(hotel.roomTypes).map(rec).map((rt) => {
              const total = rec(arr(rec(rec(arr(rt.rates)[0]).retailRate).total)[0]);
              const offerRate = rec(rt.offerRetailRate);
              const amount = offerRate.amount ?? total.amount;
              const cur = str(offerRate.currency) ?? str(total.currency) ?? currency;
              return { offerId: str(rt.offerId), amount: typeof amount === "number" ? amount : Number.NaN, currency: cur, hotelId: str(hotel.hotelId) };
            }),
          )
          .filter((c) => c.offerId !== null && Number.isFinite(c.amount) && c.currency === currency)
          .sort((a, b) => a.amount - b.amount);
        const within = candidates.filter((c) => req.max_price_minor === undefined || toMoney(c.amount, currency).amount_minor <= req.max_price_minor);
        if (candidates.length === 0) return { ok: false, reason: "NO_OFFER", detail: "no bookable rate returned", retryable: true };
        if (within.length === 0) return { ok: false, reason: "OVER_BUDGET", detail: "no rate within the price cap", retryable: false };
        offerId = within[0]!.offerId;
        hotelName = within[0]!.hotelId;
      }

      const prebook = await this.prebook(offerId!);
      if (!prebook.ok) return prebook.failure;
      const leg: PreparedLeg = {
        component_id: req.component_id,
        type: "HOTEL",
        adapter_id: "liteapi-hotels",
        provider_id: "nuitee-liteapi",
        adapter_version: VERSION,
        leg_class: "SUPPLIER_SANDBOX",
        evidence_grade: this.environment === "TEST" ? "SUPPLIER_SANDBOX" : "SUPPLIER_PRODUCTION",
        supplier_environment: this.environment,
        preparation_mode: "REVALIDATED",
        refs: emptyRefs({ offer_id: offerId, prebook_id: prebook.prebookId }),
        price: prebook.price,
        clocks: prebook.clocks,
        irreversible: prebook.irreversible,
        summary: `Hotel stay ${req.check_in} to ${req.check_out}`,
        untrusted_notes: [untrusted(hotelName, 80)].filter((n): n is string => n !== null),
        prepared_at: iso(this.clock.now()),
        request_hash: await hashJson(searchBody),
        response_hash: prebook.responseHash,
        sim: null,
      };
      return { ok: true, leg };
    } catch (err) {
      return { ok: false, reason: "SUPPLIER_ERROR", detail: err instanceof Error ? err.message : "supplier call failed", retryable: true };
    }
  }

  async revalidate(leg: PreparedLeg): Promise<RevalidateResult> {
    const checkedAt = iso(this.clock.now());
    if (!leg.refs.offer_id) return { status: "UNKNOWN", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: null, detail: "leg has no offer id" };
    try {
      const prebook = await this.prebook(leg.refs.offer_id);
      if (!prebook.ok) {
        const unavailable = prebook.failure.ok === false && (prebook.failure.reason === "NO_OFFER" || prebook.failure.reason === "OVER_BUDGET");
        return { status: unavailable ? "UNAVAILABLE" : "UNKNOWN", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: null, detail: prebook.failure.ok === false ? prebook.failure.detail : null };
      }
      const updated: PreparedLeg = { ...leg, price: prebook.price, clocks: prebook.clocks, irreversible: prebook.irreversible, refs: { ...leg.refs, prebook_id: prebook.prebookId } };
      return {
        status: prebook.price.amount_minor === leg.price.amount_minor ? "UNCHANGED" : "PRICE_CHANGED",
        leg: updated,
        previous_price: leg.price,
        checked_at: checkedAt,
        response_hash: prebook.responseHash,
        detail: null,
      };
    } catch (err) {
      return { status: "UNKNOWN", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: null, detail: err instanceof Error ? err.message : "supplier call failed" };
    }
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const respondedAt = (): string => iso(this.clock.now());
    const reason = this.unconfiguredReason;
    if (reason) return this.rejected(req, "not_configured", reason, respondedAt());
    if (!req.leg.refs.prebook_id) return this.rejected(req, "no_prebook", "leg has no prebook id", respondedAt());
    if (req.leg.price.amount_minor > req.max_total.amount_minor) return this.rejected(req, "over_max_total", "leg price exceeds the committed maximum", respondedAt());

    const body = {
      prebookId: req.leg.refs.prebook_id,
      clientReference: req.idempotency_ref,
      holder: { firstName: req.traveler.given_name, lastName: req.traveler.family_name, email: req.traveler.email, phone: req.traveler.phone_number },
      guests: [{ occupancyNumber: 1, firstName: req.traveler.given_name, lastName: req.traveler.family_name, email: req.traveler.email }],
      payment: { method: "ACC_CREDIT_CARD" },
    };
    let res: JsonResponse;
    try {
      res = await this.call("POST", `${this.options.bookUrl ?? BOOK_URL}/rates/book`, body, COMMIT_TIMEOUT_MS);
    } catch (err) {
      const detail = err instanceof SupplierTimeoutError ? "supplier did not answer before the timeout" : "network error during commit";
      return { response: "UNKNOWN", no_booking_certain: false, refs: req.leg.refs, price: null, supplier_status: null, error_code: "timeout", detail, responded_at: respondedAt(), response_hash: null };
    }
    const responseHash = await hashJson(res.body);
    if (res.status === 200 || res.status === 201) {
      const data = rec(rec(res.body).data);
      const status = str(data.status);
      const bookingId = str(data.bookingId);
      const price = typeof data.price === "number" && str(data.currency) ? toMoney(data.price, String(data.currency)) : req.leg.price;
      const refs: SupplierRefs = { ...req.leg.refs, booking_id: bookingId, booking_reference: str(data.hotelConfirmationCode) };
      if (status === "CONFIRMED" && bookingId) {
        return { response: "RESPONDED_CONFIRMED", no_booking_certain: false, refs, price, supplier_status: status, error_code: null, detail: null, responded_at: respondedAt(), response_hash: responseHash };
      }
      return { response: "UNKNOWN", no_booking_certain: false, refs, price, supplier_status: status, error_code: null, detail: "booking response without a confirmed status", responded_at: respondedAt(), response_hash: responseHash };
    }
    const err = errorCode(res.body);
    if (err.code !== null && MAYBE_BOOKED.has(err.code)) {
      return { response: "UNKNOWN", no_booking_certain: false, refs: req.leg.refs, price: null, supplier_status: null, error_code: String(err.code), detail: err.message, responded_at: respondedAt(), response_hash: responseHash };
    }
    if (res.status >= 400 && res.status < 500 && (err.code === null || DEFINITE_REJECTIONS.has(err.code))) {
      return { response: "REJECTED", no_booking_certain: true, refs: req.leg.refs, price: null, supplier_status: null, error_code: err.code !== null ? String(err.code) : `http_${res.status}`, detail: err.message, responded_at: respondedAt(), response_hash: responseHash };
    }
    return { response: "UNKNOWN", no_booking_certain: false, refs: req.leg.refs, price: null, supplier_status: null, error_code: err.code !== null ? String(err.code) : `http_${res.status}`, detail: err.message ?? "supplier error with unknown booking state", responded_at: respondedAt(), response_hash: responseHash };
  }

  async postcondition(leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult> {
    if (!refs.booking_id) return this.reconcileByReference(leg, "");
    try {
      const res = await this.call("GET", `${this.options.bookUrl ?? BOOK_URL}/bookings/${encodeURIComponent(refs.booking_id)}`, undefined, READ_TIMEOUT_MS);
      if (res.status !== 200) return this.read("UNKNOWN", refs, `booking read failed with ${res.status}`);
      const data = rec(rec(res.body).data);
      const status = str(data.status);
      const cancelled = status !== null && status.startsWith("CANCELLED");
      return {
        found: "PRESENT",
        confirmed: status === "CONFIRMED",
        cancelled,
        refs: { ...refs, booking_reference: str(data.hotelConfirmationCode) ?? refs.booking_reference },
        price: typeof data.price === "number" && str(data.currency) ? toMoney(data.price, String(data.currency)) : null,
        supplier_status: status,
        absent_is_final: false,
        evidence_tier: "E1",
        read_at: iso(this.clock.now()),
        response_hash: await hashJson(res.body),
        detail: null,
      };
    } catch (err) {
      return this.read("UNKNOWN", refs, err instanceof Error ? err.message : "supplier call failed");
    }
  }

  /**
   * LiteAPI documents no lookup by clientReference. The booking id is required
   * for a read, so a lost response stays UNKNOWN until a human or a webhook
   * supplies it. Retrying book with the same clientReference is safe (4005)
   * but that is a write, and the kernel decides whether to do it.
   */
  async reconcileByReference(leg: PreparedLeg, _idempotencyRef: string): Promise<PostconditionResult> {
    return this.read("UNKNOWN", leg.refs, "no read path by client reference; booking id required");
  }

  async quoteCancellation(leg: PreparedLeg, refs: SupplierRefs): Promise<CancelQuote> {
    if (!refs.booking_id) return { refund: null, fee: null, refund_destination: "UNKNOWN", certainty: "UNKNOWN", valid_until: null, cancellable: false, detail: "no booking to cancel" };
    const now = this.clock.now().toISOString();
    const free = leg.clocks.free_cancel_until !== null && now < leg.clocks.free_cancel_until;
    return {
      refund: free ? leg.price : null,
      fee: free ? { ...leg.price, amount_minor: 0 } : null,
      refund_destination: free ? "CASH" : leg.clocks.refund_destination,
      certainty: free ? "ESTIMATED" : "UNKNOWN",
      valid_until: leg.clocks.free_cancel_until,
      cancellable: true,
      detail: "computed from the rate cancellation policy; the supplier states the final amount on cancel",
    };
  }

  async cancel(_leg: PreparedLeg, refs: SupplierRefs): Promise<CancelResult> {
    const respondedAt = (): string => iso(this.clock.now());
    if (!refs.booking_id) return { outcome: "REFUSED", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: null, detail: "no booking to cancel" };
    try {
      const res = await this.call("PUT", `${this.options.bookUrl ?? BOOK_URL}/bookings/${encodeURIComponent(refs.booking_id)}`, undefined, COMMIT_TIMEOUT_MS);
      const hash = await hashJson(res.body);
      if (res.status !== 200) {
        return { outcome: res.status >= 500 ? "UNKNOWN" : "REFUSED", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: hash, detail: errorCode(res.body).message ?? `cancel failed with ${res.status}` };
      }
      const data = rec(rec(res.body).data);
      const status = str(data.status);
      const currency = str(data.currency) ?? "USD";
      const refund: Money | null = typeof data.refund_amount === "number" ? toMoney(data.refund_amount, currency) : null;
      const fee: Money | null = typeof data.cancellation_fee === "number" ? toMoney(data.cancellation_fee, currency) : null;
      const outcome = status === "CANCELLED" ? "CANCELLED" : status === "CANCELLED_WITH_CHARGES" ? "CANCELLED_WITH_CHARGES" : "UNKNOWN";
      return { outcome, refund, fee, refund_destination: refund && refund.amount_minor > 0 ? "CASH" : "NONE", responded_at: respondedAt(), response_hash: hash, detail: null };
    } catch (err) {
      return { outcome: "UNKNOWN", refund: null, fee: null, refund_destination: "UNKNOWN", responded_at: respondedAt(), response_hash: null, detail: err instanceof Error ? err.message : "supplier call failed" };
    }
  }

  private async prebook(offerId: string): Promise<
    | { ok: true; prebookId: string; price: Money; clocks: ComponentClocks; irreversible: boolean; responseHash: string }
    | { ok: false; failure: PrepareResult }
  > {
    const res = await this.call("POST", `${this.options.bookUrl ?? BOOK_URL}/rates/prebook`, { offerId, usePaymentSdk: false }, READ_TIMEOUT_MS);
    if (res.status !== 200) {
      const err = errorCode(res.body);
      const noOffer = err.code === 2001 || err.code === 4016;
      return { ok: false, failure: { ok: false, reason: noOffer ? "NO_OFFER" : "SUPPLIER_ERROR", detail: err.message ?? `prebook failed with ${res.status}`, retryable: !noOffer } };
    }
    const data = rec(rec(res.body).data);
    const prebookId = str(data.prebookId);
    const currency = str(data.currency) ?? "USD";
    const firstRate = rec(arr(rec(arr(data.roomTypes)[0]).rates)[0]);
    const rateTotal = rec(arr(rec(firstRate.retailRate).total)[0]);
    const amount = typeof data.price === "number" ? data.price : typeof rateTotal.amount === "number" ? rateTotal.amount : null;
    if (!prebookId || amount === null) {
      return { ok: false, failure: { ok: false, reason: "SUPPLIER_ERROR", detail: "prebook response missing prebookId or price", retryable: true } };
    }
    const { clocks, irreversible } = clocksFromPolicies(rec(firstRate.cancellationPolicies), null);
    return { ok: true, prebookId, price: toMoney(amount, currency), clocks, irreversible, responseHash: await hashJson(res.body) };
  }

  private rejected(req: CommitRequest, code: string, detail: string, respondedAt: string): CommitResult {
    return { response: "REJECTED", no_booking_certain: true, refs: req.leg.refs, price: null, supplier_status: null, error_code: code, detail, responded_at: respondedAt, response_hash: null };
  }

  private read(found: PostconditionResult["found"], refs: SupplierRefs, detail: string): PostconditionResult {
    return { found, confirmed: false, cancelled: false, refs, price: null, supplier_status: null, absent_is_final: false, evidence_tier: "E1", read_at: iso(this.clock.now()), response_hash: null, detail };
  }

  private call(method: "GET" | "POST" | "PUT", url: string, body: unknown, timeoutMs: number): Promise<JsonResponse> {
    return fetchJson(
      this.fetchImpl,
      url,
      {
        method,
        headers: { "X-API-Key": this.options.apiKey ?? "", Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
  }
}
