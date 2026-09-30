import { describe, expect, it } from "vitest";

import { parsePaymentRequired, SANDBOX_TRAVELER, X402MerchantAdapter, type FetchLike, type MerchantCatalogEntry } from "../src";

const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const PAY_TO = "IYNQCLXJUQFCQLAQYN4YOUYVHKIRHNIPP3HKBTEJC5666FJDZKY5AFEJUI";
const PAYER = "X6RVK5VDE2KQOEWURVUWGAPNEL5FYFTJXJFODKO55MN3JRX4DBQTPQ4BDQ";
const requirement = { scheme: "exact", network: NETWORK, amount: "1000", asset: "31566704", payTo: PAY_TO, maxTimeoutSeconds: 300 };
const challenge = btoa(JSON.stringify({ x402Version: 2, accepts: [requirement] }));
const catalog: MerchantCatalogEntry[] = [{ merchant_id: "fx-usd", type: "DATA", title: "FX rates", url: "https://merchant.example/fx", method: "GET", max_price_atomic: 10_000 }];
const clock = { now: () => new Date("2026-10-01T12:00:00Z") };

const probe: FetchLike = async () => new Response(JSON.stringify({}), { status: 402, headers: { "payment-required": challenge } });

function paying(status: number, settle: unknown): FetchLike {
  return async () => new Response(JSON.stringify({ rates: { EUR: 0.92 } }), { status, headers: settle ? { "payment-response": btoa(JSON.stringify(settle)) } : {} });
}

function indexer(tx: unknown, status = 200): FetchLike {
  return async (url) => (url.includes("/v2/transactions/") ? new Response(JSON.stringify({ transaction: tx }), { status }) : probe(url));
}

function adapter(extra: { payingFetch?: FetchLike; fetch?: FetchLike } = {}): X402MerchantAdapter {
  return new X402MerchantAdapter({ catalog, networks: [NETWORK], indexerUrl: "https://idx.example", payerAddress: PAYER, fetch: extra.fetch ?? probe, payingFetch: extra.payingFetch, clock });
}

describe("x402-merchant", () => {
  it("parses v2 payment requirements from the header and ignores non-exact schemes", () => {
    expect(parsePaymentRequired(challenge, null)).toEqual([requirement]);
    expect(parsePaymentRequired(null, { accepts: [{ ...requirement, scheme: "upto" }] })).toEqual([]);
  });

  it("is unconfigured without an outbound payer and prepares an irreversible USDC leg", async () => {
    expect(adapter().metadata().configured).toBe(false);
    const res = await adapter({ payingFetch: paying(200, null) }).prepare({ component_id: "data-3", type: "DATA", offer_id: "fx-usd", adults: 1, currency: "USDC" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leg.price).toEqual({ amount_minor: 1000, currency: "USDC" });
    expect(res.leg.irreversible).toBe(true);
    expect(res.leg.leg_class).toBe("X402_MERCHANT");
  });

  it("confirms only when the indexer shows the exact transfer from our payer", async () => {
    const prep = await adapter({ payingFetch: paying(200, null) }).prepare({ component_id: "data-3", type: "DATA", offer_id: "fx-usd", adults: 1, currency: "USDC" });
    if (!prep.ok) throw new Error("prepare failed");
    const settle = { success: true, transaction: "TXID123", network: NETWORK, payer: PAYER };
    const good = { sender: PAYER, "confirmed-round": 100, "asset-transfer-transaction": { "asset-id": 31566704, receiver: PAY_TO, amount: 1000 } };
    const a = adapter({ payingFetch: paying(200, settle), fetch: indexer(good) });
    const commit = await a.commit({ leg: prep.leg, operation_id: "op", idempotency_ref: "r", max_total: prep.leg.price, traveler: SANDBOX_TRAVELER });
    expect(commit.response).toBe("RESPONDED_CONFIRMED");
    expect(commit.refs.booking_id).toBe("TXID123");
    const read = await a.postcondition(prep.leg, commit.refs);
    expect([read.found, read.confirmed, read.evidence_tier]).toEqual(["PRESENT", true, "E2"]);

    const wrongAmount = adapter({ fetch: indexer({ ...good, "asset-transfer-transaction": { ...good["asset-transfer-transaction"], amount: 999 } }) });
    expect((await wrongAmount.postcondition(prep.leg, commit.refs)).confirmed).toBe(false);
    const notYet = adapter({ fetch: indexer({}, 404) });
    expect((await notYet.postcondition(prep.leg, commit.refs)).found).toBe("UNKNOWN");
  });

  it("maps a second challenge to a definite rejection and a server error after settlement to UNKNOWN", async () => {
    const prep = await adapter({ payingFetch: paying(200, null) }).prepare({ component_id: "data-3", type: "DATA", offer_id: "fx-usd", adults: 1, currency: "USDC" });
    if (!prep.ok) throw new Error("prepare failed");
    const req = { leg: prep.leg, operation_id: "op", idempotency_ref: "r", max_total: prep.leg.price, traveler: SANDBOX_TRAVELER };
    const rejected = await adapter({ payingFetch: paying(402, null) }).commit(req);
    expect([rejected.response, rejected.no_booking_certain]).toEqual(["REJECTED", true]);
    const unknown = await adapter({ payingFetch: paying(500, { success: true, transaction: "TX9" }) }).commit(req);
    expect([unknown.response, unknown.refs.booking_id]).toEqual(["UNKNOWN", "TX9"]);
  });

  it("refuses a quote above the catalog cap and never cancels", async () => {
    const dear = btoa(JSON.stringify({ accepts: [{ ...requirement, amount: "999999" }] }));
    const a = new X402MerchantAdapter({ catalog, networks: [NETWORK], indexerUrl: "https://idx.example", fetch: async () => new Response("{}", { status: 402, headers: { "payment-required": dear } }), clock });
    const res = await a.prepare({ component_id: "data-3", type: "DATA", offer_id: "fx-usd", adults: 1, currency: "USDC" });
    expect(res.ok ? "ok" : res.reason).toBe("OVER_BUDGET");
    expect((await a.cancel()).outcome).toBe("REFUSED");
  });
});
