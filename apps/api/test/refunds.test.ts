import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { networkConfig } from "../src/config";
import { executeRefunds, getRefundBySession, openFeeRefund, reconcileRefunds, settleSubmittedRefunds } from "../src/payments/refunds";
import { insertSession } from "../src/payments/sessions";
import { createTestD1 } from "./support/d1";

const net = networkConfig("testnet");
const genesisHash = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeChain {
  fetchFn: typeof fetch;
  submitted: Uint8Array[];
  mode: { submit: "ok" | "reject" | "down"; visible: boolean; currentRound: number };
}

function fakeChain(): FakeChain {
  const submitted: Uint8Array[] = [];
  const mode: FakeChain["mode"] = { submit: "ok", visible: false, currentRound: 2000 };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/transactions/params")) return json({ fee: 0, "min-fee": 1000, "last-round": 1500, "genesis-id": "testnet-v1.0", "genesis-hash": genesisHash });
    if (url.endsWith("/v2/transactions") && init?.method === "POST") {
      if (mode.submit === "down") return new Response("bad gateway", { status: 502 });
      if (mode.submit === "reject") return new Response("overspend", { status: 400 });
      submitted.push(init.body as Uint8Array);
      return json({ txId: "x" });
    }
    if (url.endsWith("/v2/status")) return json({ "last-round": mode.currentRound });
    const indexed = url.match(/\/v2\/transactions\/(\w+)$/);
    if (indexed && mode.visible && submitted.length > 0) {
      const txn = algosdk.decodeSignedTransaction(submitted[submitted.length - 1]!).txn;
      const axfer = txn.assetTransfer!;
      return json({
        transaction: {
          "confirmed-round": 1600,
          sender: txn.sender.toString(),
          "asset-transfer-transaction": { amount: Number(axfer.amount), "asset-id": Number(axfer.assetIndex), receiver: axfer.receiver.toString() },
        },
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchFn, submitted, mode };
}

async function paidSession(db: D1Database, payTo: string, payer: string, state: "CONFIRMED" | "UNKNOWN" = "CONFIRMED") {
  const { session } = await insertSession(db, {
    txid: `TX${Math.random().toString(36).slice(2)}`.toUpperCase(),
    route: "POST /sandbox/v1/trips/commit",
    body_hash: "sha256:x",
    network: net.caip2,
    asset: net.usdcAssetId,
    amount: "500000",
    pay_to: payTo,
    payer,
    payer_class: "EXTERNAL_ANON",
    first_valid: 1,
    last_valid: 2,
    now: new Date().toISOString(),
  });
  await db.prepare("UPDATE payment_sessions SET state = ?1 WHERE id = ?2").bind(state, session.id).run();
  return { ...session, state };
}

function setup() {
  const payTo = algosdk.generateAccount();
  const payer = algosdk.generateAccount();
  return { payTo, payer, mnemonic: algosdk.secretKeyToMnemonic(payTo.sk), db: createTestD1(), chain: fakeChain() };
}

describe("openFeeRefund", () => {
  it("requests a refund on TestNet and defers it to an operator on Mainnet, once per payment", async () => {
    const { db, payTo, payer } = setup();
    const a = await paidSession(db, payTo.addr.toString(), payer.addr.toString());
    const first = await openFeeRefund(db, { session: a, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: "trp_1", now: new Date() });
    expect(first).toMatchObject({ state: "REQUESTED", amount: "500000", reason: "FEE_REFUND_INTYR_FAILURE" });
    expect(JSON.parse(first.decision_json!)).toMatchObject({ gate: "REFUND", outcome: "ACT" });
    expect((await openFeeRefund(db, { session: a, environment: "TESTNET", delivery: "COMMIT_NOT_EXECUTED", tripId: null, now: new Date() })).id).toBe(first.id);

    const b = await paidSession(db, payTo.addr.toString(), payer.addr.toString());
    const main = await openFeeRefund(db, { session: b, environment: "MAINNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    expect(main.state).toBe("DEFERRED");
    expect(JSON.parse(main.decision_json!)).toMatchObject({ outcome: "MANUAL_REVIEW", required_role: "INTYR_OPERATOR" });
  });
});

describe("executeRefunds", () => {
  it("sends the exact fee back to the payer, records the txid first, and confirms only after an independent read", async () => {
    const { db, payTo, payer, mnemonic, chain } = setup();
    const session = await paidSession(db, payTo.addr.toString(), payer.addr.toString());
    await openFeeRefund(db, { session, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });

    expect(await executeRefunds(db, { net, mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(1);
    const sent = await getRefundBySession(db, session.id);
    expect(sent?.state).toBe("SUBMITTED");
    const txn = algosdk.decodeSignedTransaction(chain.submitted[0]!).txn;
    expect(txn.sender.toString()).toBe(payTo.addr.toString());
    expect(txn.assetTransfer?.receiver.toString()).toBe(payer.addr.toString());
    expect(txn.assetTransfer?.amount).toBe(500000n);
    expect(Number(txn.assetTransfer?.assetIndex)).toBe(10458941);
    expect(txn.fee).toBeGreaterThanOrEqual(1000n);
    expect(sent?.txid).toBe(txn.txID());

    expect(await executeRefunds(db, { net, mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(0);
    expect(chain.submitted).toHaveLength(1);

    expect(await settleSubmittedRefunds(db, { net, mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(0);
    chain.mode.visible = true;
    expect(await settleSubmittedRefunds(db, { net, mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(1);
    expect((await getRefundBySession(db, session.id))?.state).toBe("CONFIRMED");
  });

  it("never sends a Mainnet refund", async () => {
    const { db, payTo, payer, mnemonic, chain } = setup();
    const session = await paidSession(db, payTo.addr.toString(), payer.addr.toString());
    await openFeeRefund(db, { session, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    expect(await executeRefunds(db, { net: networkConfig("mainnet"), mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(0);
    expect(chain.submitted).toHaveLength(0);
  });

  it("refuses to sign from an account that is not the payTo of the payment", async () => {
    const { db, payer, chain } = setup();
    const stranger = algosdk.generateAccount();
    const session = await paidSession(db, algosdk.generateAccount().addr.toString(), payer.addr.toString());
    await openFeeRefund(db, { session, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    expect(await executeRefunds(db, { net, mnemonic: algosdk.secretKeyToMnemonic(stranger.sk), fetchFn: chain.fetchFn }, new Date())).toBe(0);
    expect(await getRefundBySession(db, session.id)).toMatchObject({ state: "REQUESTED", error: "the refund signer is not the payTo of this payment" });
    expect(chain.submitted).toHaveLength(0);
  });

  it("does not refund a payment that is not confirmed settled", async () => {
    const { db, payTo, payer, mnemonic, chain } = setup();
    const session = await paidSession(db, payTo.addr.toString(), payer.addr.toString(), "UNKNOWN");
    await openFeeRefund(db, { session, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    expect(await executeRefunds(db, { net, mnemonic, fetchFn: chain.fetchFn }, new Date())).toBe(0);
    expect(chain.submitted).toHaveLength(0);
  });

  it("marks a rejected refund FAILED, and keeps a lost submit SUBMITTED until its validity window passes", async () => {
    const a = setup();
    const rejected = await paidSession(a.db, a.payTo.addr.toString(), a.payer.addr.toString());
    await openFeeRefund(a.db, { session: rejected, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    a.chain.mode.submit = "reject";
    await executeRefunds(a.db, { net, mnemonic: a.mnemonic, fetchFn: a.chain.fetchFn }, new Date());
    expect(await getRefundBySession(a.db, rejected.id)).toMatchObject({ state: "FAILED" });

    const b = setup();
    const lost = await paidSession(b.db, b.payTo.addr.toString(), b.payer.addr.toString());
    await openFeeRefund(b.db, { session: lost, environment: "TESTNET", delivery: "INTYR_FAILURE", tripId: null, now: new Date() });
    b.chain.mode.submit = "down";
    await executeRefunds(b.db, { net, mnemonic: b.mnemonic, fetchFn: b.chain.fetchFn }, new Date());
    expect((await getRefundBySession(b.db, lost.id))?.state).toBe("SUBMITTED");
    b.chain.mode.currentRound = 1600;
    expect(await settleSubmittedRefunds(b.db, { net, mnemonic: b.mnemonic, fetchFn: b.chain.fetchFn }, new Date())).toBe(0);
    expect((await getRefundBySession(b.db, lost.id))?.state).toBe("SUBMITTED");
    b.chain.mode.currentRound = 2600;
    expect(await reconcileRefunds(b.db, { net, mnemonic: b.mnemonic, fetchFn: b.chain.fetchFn }, new Date())).toBe(1);
    expect(await getRefundBySession(b.db, lost.id)).toMatchObject({ state: "FAILED", error: "not seen on chain before its last valid round" });
  });
});
