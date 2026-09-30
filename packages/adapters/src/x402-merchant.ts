import {
  SYSTEM_CLOCK,
  type AdapterCapabilities,
  type AdapterClock,
  type AdapterMetadata,
  type CancelQuote,
  type CancelResult,
  type CommitRequest,
  type CommitResult,
  type ComponentRequest,
  type ComponentType,
  type FetchLike,
  type IntyrAdapter,
  type Money,
  type PostconditionResult,
  type PreparedLeg,
  type PrepareResult,
  type RevalidateResult,
  type SupplierRefs,
} from "./contract";
import { emptyRefs, fetchJson, hashJson, iso, rec, str, SupplierTimeoutError, unknownClocks, untrusted } from "./util";

/**
 * A leg bought from another x402 merchant on Algorand (a travel eSIM, an FX
 * rate for the trip currency, destination weather). The purchase itself is an
 * x402 payment, so the leg's outcome can be checked on chain: the postcondition
 * reads the settlement transaction from an indexer and checks sender, receiver,
 * asset and amount against the merchant's own payment requirements.
 *
 * Purchases are final. There is no cancellation and no refund path.
 */

const VERSION = "1.0.0";
const TIMEOUT_MS = 30_000;

export interface MerchantCatalogEntry {
  merchant_id: string;
  type: Extract<ComponentType, "ESIM" | "DATA">;
  title: string;
  url: string;
  method: "GET" | "POST";
  /** Query string without the leading "?", for GET merchants. */
  query?: string;
  body?: unknown;
  /** Refuse any quote above this, in USDC atomic units (6 decimals). */
  max_price_atomic: number;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number | null;
}

export interface X402MerchantOptions {
  catalog: MerchantCatalogEntry[];
  /** Plain fetch for the unpaid probe that reads the merchant's 402. */
  fetch?: FetchLike;
  /** A fetch that answers x402 challenges from Intyr's outbound payer, capped by the caller. Absent means not configured. */
  payingFetch?: FetchLike;
  /** Address of the outbound payer, used to check the settlement sender. */
  payerAddress?: string;
  /** Networks this adapter may pay on, as CAIP-2 strings (full genesis form or 32-character reference). */
  networks: string[];
  indexerUrl: string;
  clock?: AdapterClock;
}

function decodeBase64Json(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return rec(JSON.parse(atob(value)));
  } catch {
    return null;
  }
}

/** Reads x402 v2 payment requirements from the PAYMENT-REQUIRED header, falling back to the JSON body. */
export function parsePaymentRequired(headerValue: string | null, body: unknown): PaymentRequirement[] {
  const source = decodeBase64Json(headerValue) ?? rec(body);
  return (Array.isArray(source.accepts) ? source.accepts : [])
    .map(rec)
    .map((a) => ({
      scheme: String(a.scheme ?? ""),
      network: String(a.network ?? ""),
      amount: String(a.amount ?? a.maxAmountRequired ?? ""),
      asset: String(a.asset ?? ""),
      payTo: String(a.payTo ?? ""),
      maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : null,
    }))
    .filter((a) => a.scheme === "exact" && /^\d+$/.test(a.amount) && a.payTo.length > 0);
}

export class X402MerchantAdapter implements IntyrAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly clock: AdapterClock;

  constructor(private readonly options: X402MerchantOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  metadata(): AdapterMetadata {
    const configured = Boolean(this.options.payingFetch && this.options.payerAddress);
    return {
      adapter_id: "x402-merchant",
      provider_id: "x402",
      version: VERSION,
      component_types: ["ESIM", "DATA"],
      leg_class: "X402_MERCHANT",
      evidence_grade: "SUPPLIER_PRODUCTION",
      supplier_environment: "LIVE",
      configured,
      unconfigured_reason: configured ? null : "no outbound x402 payer is configured",
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      preparation_modes: ["INSTANT_COMMIT_ONLY"],
      supports_hold: false,
      supports_cancel: false,
      cancel_quote: "NONE",
      commit_idempotency: "NONE",
      status_lookup: "BY_REFERENCE",
      negative_confirmation: false,
      visibility_lag_seconds: 5,
      duplicate_sweep: false,
      commit_timeout_ms: TIMEOUT_MS,
    };
  }

  catalog(): MerchantCatalogEntry[] {
    return this.options.catalog;
  }

  async prepare(req: ComponentRequest): Promise<PrepareResult> {
    const entry = this.options.catalog.find((m) => m.merchant_id === req.offer_id);
    if (!entry) return { ok: false, reason: "INVALID_REQUEST", detail: "offer_id must name a catalog merchant", retryable: false };
    if (entry.type !== req.type) return { ok: false, reason: "INVALID_REQUEST", detail: `merchant ${entry.merchant_id} sells ${entry.type}`, retryable: false };

    let probe;
    try {
      probe = await this.probe(entry);
    } catch (err) {
      return { ok: false, reason: "SUPPLIER_ERROR", detail: err instanceof Error ? err.message : "merchant unreachable", retryable: true };
    }
    if (probe.status !== 402) return { ok: false, reason: "UNSUPPORTED", detail: `merchant answered ${probe.status}, not an x402 challenge`, retryable: false };
    const requirement = probe.requirements.find((r) => this.options.networks.includes(r.network));
    if (!requirement) return { ok: false, reason: "UNSUPPORTED", detail: "merchant does not accept a configured network", retryable: false };
    const atomic = Number.parseInt(requirement.amount, 10);
    if (atomic > entry.max_price_atomic) return { ok: false, reason: "OVER_BUDGET", detail: `merchant asks ${atomic} atomic units, cap is ${entry.max_price_atomic}`, retryable: false };
    if (req.max_price_minor !== undefined && atomic > req.max_price_minor) return { ok: false, reason: "OVER_BUDGET", detail: "merchant price exceeds the component cap", retryable: false };

    const now = this.clock.now();
    const price: Money = { amount_minor: atomic, currency: "USDC" };
    const validFor = requirement.maxTimeoutSeconds ?? 60;
    const leg: PreparedLeg = {
      component_id: req.component_id,
      type: entry.type,
      adapter_id: "x402-merchant",
      provider_id: `x402:${new URL(entry.url).host}`,
      adapter_version: VERSION,
      leg_class: "X402_MERCHANT",
      evidence_grade: "SUPPLIER_PRODUCTION",
      supplier_environment: "LIVE",
      preparation_mode: "INSTANT_COMMIT_ONLY",
      refs: emptyRefs({ offer_id: entry.merchant_id, prebook_id: `${requirement.network}|${requirement.asset}|${requirement.payTo}|${requirement.amount}` }),
      price,
      clocks: unknownClocks({
        price_valid_until: iso(new Date(now.getTime() + validFor * 1000)),
        refund_destination: "NONE",
        refund_amount_certainty: "QUOTED",
        confirmation_mode: "INSTANT",
        supplier_can_cancel: false,
      }),
      irreversible: true,
      summary: `${entry.title} from an x402 merchant`,
      untrusted_notes: [untrusted(new URL(entry.url).host, 80)].filter((n): n is string => n !== null),
      prepared_at: iso(now),
      request_hash: await hashJson({ url: entry.url, method: entry.method, query: entry.query ?? null, body: entry.body ?? null }),
      response_hash: await hashJson(probe.requirements),
      sim: null,
    };
    return { ok: true, leg };
  }

  async revalidate(leg: PreparedLeg): Promise<RevalidateResult> {
    const checkedAt = iso(this.clock.now());
    const res = await this.prepare({ component_id: leg.component_id, type: leg.type, offer_id: leg.refs.offer_id ?? "", adults: 1, currency: "USDC" });
    if (!res.ok) {
      return { status: res.reason === "SUPPLIER_ERROR" ? "UNKNOWN" : "UNAVAILABLE", leg, previous_price: leg.price, checked_at: checkedAt, response_hash: null, detail: res.detail };
    }
    const changed = res.leg.price.amount_minor !== leg.price.amount_minor || res.leg.refs.prebook_id !== leg.refs.prebook_id;
    return { status: changed ? "PRICE_CHANGED" : "UNCHANGED", leg: changed ? res.leg : leg, previous_price: leg.price, checked_at: checkedAt, response_hash: res.leg.response_hash, detail: null };
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const respondedAt = (): string => iso(this.clock.now());
    const entry = this.options.catalog.find((m) => m.merchant_id === req.leg.refs.offer_id);
    const base = { refs: req.leg.refs, price: null, supplier_status: null, response_hash: null };
    if (!entry || !this.options.payingFetch) {
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: "not_configured", detail: "no outbound payer or unknown merchant", responded_at: respondedAt() };
    }
    if (req.leg.price.amount_minor > req.max_total.amount_minor || req.leg.price.amount_minor > entry.max_price_atomic) {
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: "over_max_total", detail: "merchant price exceeds the committed maximum", responded_at: respondedAt() };
    }
    let res: Response;
    try {
      res = await this.withTimeout(this.options.payingFetch, entry, TIMEOUT_MS);
    } catch (err) {
      const detail = err instanceof SupplierTimeoutError ? "merchant did not answer before the timeout" : "network error while paying";
      return { ...base, response: "UNKNOWN", no_booking_certain: false, error_code: "timeout", detail, responded_at: respondedAt() };
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    const settle = decodeBase64Json(res.headers.get("payment-response") ?? res.headers.get("x-payment-response"));
    const txid = settle ? str(settle.transaction) : null;
    const responseHash = await hashJson({ status: res.status, body });
    if (res.ok && txid && settle?.success !== false) {
      return {
        response: "RESPONDED_CONFIRMED",
        no_booking_certain: false,
        refs: { ...req.leg.refs, booking_id: txid, booking_reference: responseHash },
        price: req.leg.price,
        supplier_status: "SETTLED",
        error_code: null,
        detail: null,
        responded_at: respondedAt(),
        response_hash: responseHash,
      };
    }
    if (res.status === 402 && !txid) {
      // A second challenge means the payment was not accepted, so nothing settled.
      return { ...base, response: "REJECTED", no_booking_certain: true, error_code: "payment_not_accepted", detail: "merchant answered with a new challenge", responded_at: respondedAt(), response_hash: responseHash };
    }
    return {
      ...base,
      refs: txid ? { ...req.leg.refs, booking_id: txid } : req.leg.refs,
      response: "UNKNOWN",
      no_booking_certain: false,
      error_code: `http_${res.status}`,
      detail: txid ? "payment settled but the merchant response was not a success" : "merchant error with unknown settlement",
      responded_at: respondedAt(),
      response_hash: responseHash,
    };
  }

  /** Reads the settlement transaction from an indexer and checks it matches the merchant's own requirements. */
  async postcondition(leg: PreparedLeg, refs: SupplierRefs): Promise<PostconditionResult> {
    const readAt = iso(this.clock.now());
    const unknown = (detail: string): PostconditionResult => ({ found: "UNKNOWN", confirmed: false, cancelled: false, refs, price: null, supplier_status: null, absent_is_final: false, evidence_tier: "E2", read_at: readAt, response_hash: null, detail });
    if (!refs.booking_id) return unknown("no settlement transaction id to read");
    const [, asset, payTo, amount] = (leg.refs.prebook_id ?? "").split("|");
    try {
      const res = await fetchJson(this.fetchImpl, `${this.options.indexerUrl}/v2/transactions/${encodeURIComponent(refs.booking_id)}`, { method: "GET" }, TIMEOUT_MS);
      if (res.status === 404) return unknown("settlement not yet visible to the indexer");
      if (res.status !== 200) return unknown(`indexer answered ${res.status}`);
      const tx = rec(rec(res.body).transaction);
      const axfer = rec(tx["asset-transfer-transaction"]);
      const matches =
        String(axfer["asset-id"]) === asset &&
        str(axfer.receiver) === payTo &&
        String(axfer.amount) === amount &&
        (!this.options.payerAddress || str(tx.sender) === this.options.payerAddress) &&
        typeof tx["confirmed-round"] === "number";
      return {
        found: "PRESENT",
        confirmed: matches,
        cancelled: false,
        refs,
        price: leg.price,
        supplier_status: matches ? "SETTLED_ON_CHAIN" : "SETTLEMENT_MISMATCH",
        absent_is_final: false,
        evidence_tier: "E2",
        read_at: readAt,
        response_hash: await hashJson(tx),
        detail: matches ? `confirmed in round ${String(tx["confirmed-round"])}` : "on-chain transfer does not match the merchant requirements",
      };
    } catch (err) {
      return unknown(err instanceof Error ? err.message : "indexer unreachable");
    }
  }

  async reconcileByReference(leg: PreparedLeg): Promise<PostconditionResult> {
    return this.postcondition(leg, leg.refs);
  }

  async quoteCancellation(): Promise<CancelQuote> {
    return { refund: null, fee: null, refund_destination: "NONE", certainty: "QUOTED", valid_until: null, cancellable: false, detail: "x402 purchases are final" };
  }

  async cancel(): Promise<CancelResult> {
    return { outcome: "REFUSED", refund: null, fee: null, refund_destination: "NONE", responded_at: iso(this.clock.now()), response_hash: null, detail: "x402 purchases are final" };
  }

  private async probe(entry: MerchantCatalogEntry): Promise<{ status: number; requirements: PaymentRequirement[] }> {
    const res = await this.withTimeout(this.fetchImpl, entry, TIMEOUT_MS);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, requirements: parsePaymentRequired(res.headers.get("payment-required"), body) };
  }

  private async withTimeout(fetchImpl: FetchLike, entry: MerchantCatalogEntry, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = entry.query ? `${entry.url}?${entry.query}` : entry.url;
    try {
      return await fetchImpl(url, {
        method: entry.method,
        headers: entry.body === undefined ? {} : { "content-type": "application/json" },
        body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new SupplierTimeoutError(url, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
