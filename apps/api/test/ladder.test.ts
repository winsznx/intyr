import { beforeEach, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { networkConfig } from "../src/config";
import { getRefundBySession, openFeeRefund, summarize } from "../src/payments/refunds";
import type { NetworkDeps } from "../src/app";
import { createLadder } from "../src/payments/ladder";
import { createX402Server } from "../src/server";
import { createApp } from "../src/app";
import type { DomainHandlers } from "../src/domain";
import type { Env } from "../src/env";
import { createTestD1 } from "./support/d1";
import { buildPaymentHeader, fakeFacilitator, newPayer, type FakeFacilitator } from "./support/payments";
import { getSessionByTxid } from "../src/payments/sessions";

const PAY_TO = newPayer().addr;
const URL_ = "https://intyr.test";

interface Harness {
  app: ReturnType<typeof createApp>;
  db: D1Database;
  fac: FakeFacilitator;
  chain: { mode: "confirmed" | "absent" | "down"; round: number; current: number; txnFor?: (txid: string) => Record<string, unknown> };
  handlerCalls: { n: number };
}

async function harness(domain?: DomainHandlers): Promise<Harness> {
  const db = createTestD1();
  const env = { DB: db, FACILITATOR_URL: "unused", PAY_TO_TESTNET: PAY_TO } as unknown as Env;
  const net = networkConfig("testnet");
  const fac = fakeFacilitator();
  const { httpServer } = createX402Server(net, PAY_TO, fac);
  await httpServer.initialize();
  const chain: Harness["chain"] = { mode: "confirmed", round: 1500, current: 1600 };
  const handlerCalls = { n: 0 };
  const fetchFn = (async (url: string) => {
    const u = String(url);
    if (chain.mode === "down") throw new Error("node unreachable");
    if (u.includes("/v2/transactions/") && !u.includes("pending")) {
      const txid = u.split("/").pop()!;
      if (chain.mode === "confirmed" && chain.txnFor) {
        return new Response(JSON.stringify({ transaction: chain.txnFor(txid) }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
    if (u.includes("/v2/transactions/pending/")) return new Response("{}", { status: 404 });
    if (u.endsWith("/v2/status")) return new Response(JSON.stringify({ "last-round": chain.current }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const ladder = createLadder({ db, httpServer, net, payTo: PAY_TO, teamWallets: [], fetchFn, confirmWaitMs: 50, sleep: async () => undefined, openRefund: ({ session, delivery, tripId }) => openFeeRefund(db, { session, environment: "TESTNET", delivery, tripId, now: new Date() }).then(summarize) });
  const handlers: DomainHandlers = domain ?? {
    "POST /v1/trips/check": {
      handler: async (ctx) => {
        handlerCalls.n++;
        return { status: 200, body: { plan_id: "man_test", echo: ctx.body } };
      },
    },
    "POST /v1/trips/commit": {
      precheck: async (body) => ((body as { refuse?: boolean }).refuse ? { status: 422, body: { outcome: "REFUSE", reason_codes: ["MANIFEST_EXPIRED"] } } : null),
      handler: async () => {
        handlerCalls.n++;
        return { status: 200, body: { state: "COMMITTED" } };
      },
    },
    "POST /v1/trips/recover": {
      handler: async () => {
        throw new Error("supplier adapter crashed");
      },
    },
  };
  const app = createApp({ env, testnet: { net, payTo: PAY_TO, ladder, domain: handlers } as NetworkDeps, version: { name: "intyr", commit: "test", contract_versions: {} } });
  return { app, db, fac, chain, handlerCalls };
}

async function challenge(h: Harness, path: string, body: unknown) {
  const res = await h.app.request(URL_ + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
  return { res, requirements: pr.accepts[0] as unknown as Record<string, unknown> };
}

function confirmedFor(h: Harness, payer: string, amount: string) {
  h.chain.txnFor = () => ({
    "confirmed-round": h.chain.round,
    sender: payer,
    "asset-transfer-transaction": { amount: Number(amount), "asset-id": 10458941, receiver: PAY_TO },
  });
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

async function pay(path: string, body: unknown, opts: { payer?: ReturnType<typeof newPayer>; header?: string } = {}) {
  const payer = opts.payer ?? newPayer();
  const { requirements } = await challenge(h, path, body);
  const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + path });
  confirmedFor(h, payer.addr, String((requirements as { amount: string }).amount));
  const res = await h.app.request(URL_ + path, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": opts.header ?? built.header },
    body: JSON.stringify(body),
  });
  return { res, payer, built, requirements };
}

describe("x402 challenge", () => {
  it("answers 402 with the challenge tag, fee payer and a Bazaar extension before any payment", async () => {
    const { res, requirements } = await challenge(h, "/sandbox/v1/trips/check", { legs: [] });
    expect(res.status).toBe(402);
    const accept = requirements as { network: string; asset: string; amount: string; payTo: string; extra: Record<string, unknown> };
    expect(accept.network).toBe("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    expect(accept.asset).toBe("10458941");
    expect(accept.amount).toBe("100000");
    expect(accept.payTo).toBe(PAY_TO);
    expect(accept.extra.tag).toBe("x402-global-challenge");
    expect(accept.extra.feePayer).toBeTruthy();
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(JSON.stringify(pr.extensions ?? {})).toContain("bazaar");
    expect(h.fac.calls.settle).toBe(0);
  });
});

describe("payment ladder", () => {
  it("settles before the handler runs and returns the operation with payment facts", async () => {
    const { res, built } = await pay("/sandbox/v1/trips/check", { legs: [1] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.plan_id).toBe("man_test");
    expect(body.payment_txid).toBe(built.txid);
    expect(["SETTLED", "CONFIRMED"]).toContain(body.payment_state);
    expect(h.fac.calls.settle).toBe(1);
    expect(h.handlerCalls.n).toBe(1);
    const s = await getSessionByTxid(h.db, built.txid);
    expect(s?.operation_id).toBeTruthy();
  });

  it("replaying the same proof returns the same operation and never settles or runs twice", async () => {
    const first = await pay("/sandbox/v1/trips/check", { legs: [1] });
    const firstBody = (await first.res.json()) as Record<string, unknown>;
    const again = await h.app.request(URL_ + "/sandbox/v1/trips/check", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": first.built.header },
      body: JSON.stringify({ legs: [1] }),
    });
    const againBody = (await again.json()) as Record<string, unknown>;
    expect(again.status).toBe(200);
    expect(againBody.operation_id).toBe(firstBody.operation_id);
    expect(againBody.replay).toBe(true);
    expect(h.fac.calls.settle).toBe(1);
    expect(h.handlerCalls.n).toBe(1);
  });

  it("rejects a proof reused for a different body with PAYMENT_BINDING_MISMATCH and does no work", async () => {
    const first = await pay("/sandbox/v1/trips/check", { legs: [1] });
    expect(first.res.status).toBe(200);
    const other = await h.app.request(URL_ + "/sandbox/v1/trips/check", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": first.built.header },
      body: JSON.stringify({ legs: [1, 2] }),
    });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: string }).error).toBe("PAYMENT_BINDING_MISMATCH");
    expect(h.handlerCalls.n).toBe(1);
  });

  it("answers an unpaid request with the 402 even when its body would be refused, then refuses the paid retry before settling", async () => {
    const unpaid = await h.app.request(URL_ + "/sandbox/v1/trips/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refuse: true }) });
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("payment-required")).not.toBeNull();

    const refused = await pay("/sandbox/v1/trips/commit", { refuse: true });
    expect(refused.res.status).toBe(422);
    const body = (await refused.res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("REFUSE");
    expect(body.charged).toBe(false);
    expect(h.fac.calls.verify + h.fac.calls.settle).toBe(0);
    const sessions = await h.db.prepare("SELECT COUNT(*) AS n FROM payment_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  it("hands the payment's sender to the precheck, so a stranger is refused before anything settles", async () => {
    const owner = newPayer();
    h = await harness({
      "POST /v1/trips/commit": {
        precheck: async (_body, actor) => (actor.payer === owner.addr ? null : { status: 403, body: { error: "NOT_TRIP_OWNER", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"] } }),
        handler: async () => ({ status: 200, body: { state: "COMMITTED" } }),
      },
    });
    const stranger = await pay("/sandbox/v1/trips/commit", { trip_id: "trp_1" });
    expect(stranger.res.status).toBe(403);
    expect(await stranger.res.json()).toMatchObject({ error: "NOT_TRIP_OWNER", charged: false });
    expect(h.fac.calls.settle).toBe(0);
    const before = await h.db.prepare("SELECT COUNT(*) AS n FROM payment_sessions").first<{ n: number }>();
    expect(before?.n).toBe(0);

    const mine = await pay("/sandbox/v1/trips/commit", { trip_id: "trp_1" }, { payer: owner });
    expect(mine.res.status).toBe(200);
  });

  it("answers every paid route with a 402 to an empty body, which is what payment tooling sends", async () => {
    // The harness implements these three. A route with no implementation answers 503 instead, so nobody is offered a payment for it.
    for (const path of ["check", "commit", "recover"]) {
      const res = await h.app.request(`${URL_}/sandbox/v1/trips/${path}`, { method: "POST" });
      expect(res.status, path).toBe(402);
    }
    expect((await h.app.request(`${URL_}/sandbox/v1/trips/prepare`, { method: "POST" })).status).toBe(503);
    const garbled = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(garbled.status).toBe(402);
  });

  it("rejects a paid request whose body is not JSON before reading the proof", async () => {
    const { requirements } = await challenge(h, "/sandbox/v1/trips/check", {});
    const built = buildPaymentHeader({ payer: newPayer(), requirements, resourceUrl: URL_ + "/sandbox/v1/trips/check" });
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: "{not json" });
    expect(res.status).toBe(400);
    expect(h.fac.calls.settle).toBe(0);
  });

  it("does not re-run a pending operation inside its lease, and a replay skips the precheck", async () => {
    const first = await pay("/sandbox/v1/trips/commit", { trip_id: "trp_1" });
    expect(first.res.status).toBe(200);
    const session = await h.db.prepare("SELECT id FROM payment_sessions").first<{ id: string }>();
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const replay = () => h.app.request(URL_ + "/sandbox/v1/trips/commit", { method: "POST", headers: { "content-type": "application/json", "payment-signature": first.built.header }, body: JSON.stringify({ trip_id: "trp_1" }) });

    await h.db.prepare("UPDATE operations SET status = 'PENDING', result_json = NULL, http_status = NULL, updated_at = ?1 WHERE session_id = ?2").bind(ago(31_000), session!.id).run();
    const inside = await replay();
    expect(inside.status).toBe(202);
    expect(await inside.json()).toMatchObject({ status: "PROCESSING", poll_url: expect.stringContaining("/sandbox/v1/operations/") });
    expect(h.handlerCalls.n).toBe(1);

    await h.db.prepare("UPDATE operations SET updated_at = ?1 WHERE session_id = ?2").bind(ago(11 * 60_000), session!.id).run();
    expect((await replay()).status).toBe(200);
    expect(h.handlerCalls.n).toBe(2);
  });

  it("rejects a payment whose amount does not match the route before contacting the facilitator", async () => {
    const payer = newPayer();
    const { requirements } = await challenge(h, "/sandbox/v1/trips/check", {});
    const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + "/sandbox/v1/trips/check", amount: "1" });
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: "{}" });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("PAYMENT_INVALID");
    expect(h.fac.calls.verify + h.fac.calls.settle).toBe(0);
  });

  it("never answers 402 for an unknown settlement: 202 PAYMENT_PENDING, then resolves by reading the stored txid", async () => {
    h.fac.mode.settle = "throw";
    const payer = newPayer();
    const { requirements } = await challenge(h, "/sandbox/v1/trips/check", { a: 1 });
    const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + "/sandbox/v1/trips/check" });
    h.chain.mode = "absent";
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("PAYMENT_PENDING");
    expect(body.payment_state).toBe("UNKNOWN");
    expect(body.payment_txid).toBe(built.txid);
    expect(body.poll_url).toBe(`${URL_}/sandbox/v1/payments/${body.payment_session_id}`);
    expect(h.handlerCalls.n).toBe(0);

    // The money did land. The node now shows it, and replaying the same proof runs the work once.
    h.chain.mode = "confirmed";
    confirmedFor(h, payer.addr, "100000");
    const again = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ a: 1 }) });
    expect(again.status).toBe(200);
    expect(h.handlerCalls.n).toBe(1);
    expect(h.fac.calls.settle).toBe(1);
  });

  it("proceeds when the facilitator response is lost but the ledger shows the payment", async () => {
    h.fac.mode.settle = "throw";
    const payer = newPayer();
    const { requirements } = await challenge(h, "/sandbox/v1/trips/check", { a: 2 });
    const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + "/sandbox/v1/trips/check" });
    confirmedFor(h, payer.addr, "100000");
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ a: 2 }) });
    expect(res.status).toBe(200);
    expect(h.handlerCalls.n).toBe(1);
  });

  it("does nothing and charges nothing when the payment never confirms and its window has passed", async () => {
    h.fac.mode.settle = "fail";
    const payer = newPayer();
    const { requirements } = await challenge(h, "/sandbox/v1/trips/check", { a: 3 });
    const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + "/sandbox/v1/trips/check", lastValid: 2000 });
    h.chain.mode = "absent";
    h.chain.current = 5000;
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ a: 3 }) });
    expect(res.status).toBe(402);
    expect(h.handlerCalls.n).toBe(0);
    const s = await getSessionByTxid(h.db, built.txid);
    expect(s?.state).toBe("EXPIRED_UNSETTLED");
  });

  it("requires our own chain read before a commit starts and answers 202 while the ledger has not shown it", async () => {
    const payer = newPayer();
    const { requirements } = await challenge(h, "/sandbox/v1/trips/commit", { trip_id: "trp_1" });
    const built = buildPaymentHeader({ payer, requirements, resourceUrl: URL_ + "/sandbox/v1/trips/commit" });
    h.chain.mode = "absent";
    const res = await h.app.request(URL_ + "/sandbox/v1/trips/commit", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ trip_id: "trp_1" }) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("PAYMENT_CONFIRMATION_PENDING");
    expect(h.handlerCalls.n).toBe(0);
  });

  it("records a failed operation with a refund record and replays it on the same proof", async () => {
    const { res, built } = await pay("/sandbox/v1/trips/recover", { trip_id: "trp_2" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { outcome: string; refund: { state: string }; operation_id: string };
    expect(body.outcome).toBe("FAILED_INTERNAL");
    expect(body.refund.state).toBe("REQUESTED");
    const stored = await getRefundBySession(h.db, (body as unknown as { payment_session_id: string }).payment_session_id);
    expect(stored).toMatchObject({ state: "REQUESTED", delivery: "INTYR_FAILURE", amount: "250000" });
    const again = await h.app.request(URL_ + "/sandbox/v1/trips/recover", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ trip_id: "trp_2" }) });
    expect(again.status).toBe(500);
    expect(((await again.json()) as { operation_id: string }).operation_id).toBe(body.operation_id);
  });

  it("records a refund when the handler reports the fee bought nothing, and never twice for one payment", async () => {
    h = await harness({
      "POST /v1/trips/commit": { handler: async () => ({ status: 409, body: { outcome: "NO_ACTION", no_supplier_call_made: true }, feeFailure: "COMMIT_NOT_EXECUTED" }) },
    });
    const { res, built } = await pay("/sandbox/v1/trips/commit", { trip_id: "trp_1" });
    const body = (await res.json()) as { refund: { id: string; state: string }; payment_session_id: string };
    expect(body.refund.state).toBe("REQUESTED");
    const replay = await h.app.request(URL_ + "/sandbox/v1/trips/commit", { method: "POST", headers: { "content-type": "application/json", "payment-signature": built.header }, body: JSON.stringify({ trip_id: "trp_1" }) });
    expect(((await replay.json()) as { refund: { id: string } }).refund.id).toBe(body.refund.id);
    const rows = await h.db.prepare("SELECT COUNT(*) AS n FROM refunds").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const poll = (await (await h.app.request(`${URL_}/sandbox/v1/payments/${body.payment_session_id}`)).json()) as { refund: { id: string; state: string } };
    expect(poll.refund).toMatchObject({ id: body.refund.id, state: "REQUESTED" });
  });

  it("refuses an oversized body with 413 before any payment is read or any work starts", async () => {
    const big = JSON.stringify({ pad: "x".repeat(70_000) });
    const declared = await h.app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ error: "PAYLOAD_TOO_LARGE", charged: false, limit_bytes: 65536 });
    const streamed = await h.app.request(URL_ + "/sandbox/v1/trips/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode(big)); ctrl.close(); } }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    const sessions = await h.db.prepare("SELECT COUNT(*) AS n FROM payment_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect(h.handlerCalls.n).toBe(0);
  });

  it("serves the agent card the facilitator reads for merchant enrichment", async () => {
    const res = await h.app.request(URL_ + "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; payment: { payTo: string }; skills: unknown[] };
    expect(card).toMatchObject({ name: "Intyr", payment: { payTo: PAY_TO } });
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it("tags payments from team wallets as INTERNAL_VALIDATION", async () => {
    const payer = newPayer();
    const db = createTestD1();
    const env = { DB: db, FACILITATOR_URL: "unused", PAY_TO_TESTNET: PAY_TO } as unknown as Env;
    const net = networkConfig("testnet");
    const fac = fakeFacilitator();
    const { httpServer } = createX402Server(net, PAY_TO, fac);
    await httpServer.initialize();
    const fetchFn = (async (u: string) => {
      if (String(u).includes("/v2/transactions/") && !String(u).includes("pending"))
        return new Response(JSON.stringify({ transaction: { "confirmed-round": 1, sender: payer.addr, "asset-transfer-transaction": { amount: 100000, "asset-id": 10458941, receiver: PAY_TO } } }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const ladder = createLadder({ db, httpServer, net, payTo: PAY_TO, teamWallets: [payer.addr], fetchFn, confirmWaitMs: 10, sleep: async () => undefined });
    const app = createApp({ env, testnet: { net, payTo: PAY_TO, ladder, domain: { "POST /v1/trips/check": { handler: async () => ({ status: 200, body: {} }) } } } as NetworkDeps, version: { name: "t", commit: "t", contract_versions: {} } });
    const ch = await app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    const reqs = decodePaymentRequiredHeader(ch.headers.get("payment-required")!).accepts[0] as unknown as Record<string, unknown>;
    const built = buildPaymentHeader({ payer, requirements: reqs, resourceUrl: URL_ + "/sandbox/v1/trips/check" });
    const res = await app.request(URL_ + "/sandbox/v1/trips/check", { method: "POST", body: "{}", headers: { "content-type": "application/json", "payment-signature": built.header } });
    expect(res.status).toBe(200);
    expect((await getSessionByTxid(db, built.txid))?.payer_class).toBe("INTERNAL_VALIDATION");
  });
});

describe("unbuilt routes", () => {
  it("refuse before any charge and never issue a 402", async () => {
    const h2 = await harness({});
    const res = await h2.app.request(URL_ + "/sandbox/v1/trips/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
    expect(res.headers.get("payment-required")).toBeNull();
  });
});

describe("public stats and trips", () => {
  it("reports settled calls and payer classes without counting unsettled payments", async () => {
    await pay("/sandbox/v1/trips/check", { legs: [1] });
    const res = await h.app.request(URL_ + "/sandbox/v1/stats/public");
    const stats = (await res.json()) as { paid_calls: number; usdc_settled: string; distinct_payers: number; repeat_payers: number };
    expect(stats.paid_calls).toBe(1);
    expect(stats.usdc_settled).toBe("0.1");
    expect(stats.distinct_payers).toBe(1);
    expect(stats.repeat_payers).toBe(0);
  });
});
