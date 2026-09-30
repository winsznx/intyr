import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { anchorHash, checkAnchor, noteFor, reconcileAnchors } from "../src/anchor";
import { networkConfig } from "../src/config";
import { TripStore } from "../src/domain/store";
import { createTestD1 } from "./support/d1";

const HASH = `sha256:${"ab".repeat(32)}`;
const net = networkConfig("testnet");
const genesisHash = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

interface ChainFake {
  fetchFn: typeof fetch;
  submitted: Uint8Array[];
}

function chainFake(opts: { confirmAfterPolls?: number; rejectSubmit?: boolean } = {}): ChainFake {
  const submitted: Uint8Array[] = [];
  let polls = 0;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/transactions/params")) return json({ fee: 0, "min-fee": 1000, "last-round": 500, "genesis-id": "testnet-v1.0", "genesis-hash": genesisHash });
    if (url.endsWith("/v2/transactions") && init?.method === "POST") {
      if (opts.rejectSubmit) return new Response("overspend", { status: 400 });
      submitted.push(init.body as Uint8Array);
      return json({ txId: "ignored" });
    }
    if (url.includes("/v2/transactions/pending/")) {
      polls++;
      return polls > (opts.confirmAfterPolls ?? 0) ? json({ "confirmed-round": 512 }) : json({ "pool-error": "" });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, submitted };
}

function signer(fetchFn: typeof fetch) {
  const account = algosdk.generateAccount();
  return { net, mnemonic: algosdk.secretKeyToMnemonic(account.sk), fetchFn, confirmWaitMs: 50, sleep: async () => undefined, address: account.addr.toString() };
}

describe("anchorHash", () => {
  it("submits a zero-value self payment whose note carries the manifest hash", async () => {
    const fake = chainFake();
    const s = signer(fake.fetchFn);
    const store = new TripStore(createTestD1());
    const ref = await anchorHash(s, "man_1", HASH, store);

    expect(ref.state).toBe("CONFIRMED");
    expect(ref.confirmed_round).toBe(512);
    expect(fake.submitted).toHaveLength(1);
    const txn = algosdk.decodeSignedTransaction(fake.submitted[0]!).txn;
    expect(txn.fee).toBeGreaterThanOrEqual(1000n);
    expect(txn.payment?.amount).toBe(0n);
    expect(txn.sender.toString()).toBe(s.address);
    expect(txn.payment?.receiver.toString()).toBe(s.address);
    expect(new TextDecoder().decode(txn.note)).toBe(noteFor(HASH));
    expect(ref.txid).toBe(txn.txID());

    const row = await store.getAnchor("man_1");
    expect(row).toMatchObject({ state: "CONFIRMED", round: 512, txid: ref.txid });
  });

  it("records the txid before submitting and leaves the anchor PENDING when confirmation is slow", async () => {
    const fake = chainFake({ confirmAfterPolls: Number.MAX_SAFE_INTEGER });
    const store = new TripStore(createTestD1());
    const ref = await anchorHash(signer(fake.fetchFn), "man_2", HASH, store);
    expect(ref.state).toBe("PENDING");
    expect(ref.confirmed_round).toBeUndefined();
    expect((await store.getAnchor("man_2"))?.state).toBe("PENDING");
    expect(await store.listPendingAnchors()).toMatchObject([{ manifest_id: "man_2", network: "testnet", txid: ref.txid }]);
  });

  it("marks the anchor FAILED and throws when algod rejects the transaction", async () => {
    const store = new TripStore(createTestD1());
    await expect(anchorHash(signer(chainFake({ rejectSubmit: true }).fetchFn), "man_3", HASH, store)).rejects.toThrow(/anchor submit failed/);
    expect(await store.getAnchor("man_3")).toMatchObject({ state: "FAILED" });
  });
});

describe("reconcileAnchors", () => {
  it("confirms an anchor that was still pending when its request ended", async () => {
    const store = new TripStore(createTestD1());
    const slow = chainFake({ confirmAfterPolls: Number.MAX_SAFE_INTEGER });
    const ref = await anchorHash(signer(slow.fetchFn), "man_4", HASH, store);
    expect(ref.state).toBe("PENDING");

    const later = chainFake();
    expect(await reconcileAnchors(store, net, new Date(), later.fetchFn)).toBe(1);
    expect(await store.getAnchor("man_4")).toMatchObject({ state: "CONFIRMED", round: 512 });
    expect(await reconcileAnchors(store, net, new Date(), later.fetchFn)).toBe(0);
  });
});

describe("reconcileAnchors expiry", () => {
  it("fails an anchor that is still unseen after its validity window and stops polling it", async () => {
    const store = new TripStore(createTestD1());
    await anchorHash(signer(chainFake({ confirmAfterPolls: Number.MAX_SAFE_INTEGER }).fetchFn), "man_5", HASH, store);
    const stillAbsent = chainFake({ confirmAfterPolls: Number.MAX_SAFE_INTEGER }).fetchFn;
    expect(await reconcileAnchors(store, net, new Date(), stillAbsent)).toBe(0);
    expect((await store.getAnchor("man_5"))?.state).toBe("PENDING");
    expect(await reconcileAnchors(store, net, new Date(Date.now() + 2 * 3600_000), stillAbsent)).toBe(1);
    expect(await store.getAnchor("man_5")).toMatchObject({ state: "FAILED" });
    expect(await store.listPendingAnchors()).toEqual([]);
  });
});

describe("checkAnchor", () => {
  const indexer = (note: string | null, round: number | null): typeof fetch => async () =>
    new Response(JSON.stringify({ transaction: { ...(note !== null ? { note: btoa(note) } : {}), ...(round !== null ? { "confirmed-round": round } : {}) } }), { status: 200 });

  it("confirms when the indexed note matches the manifest hash", async () => {
    expect(await checkAnchor(net, "TX", HASH, indexer(noteFor(HASH), 9))).toEqual({ state: "ANCHOR_CONFIRMED", round: 9, txid: "TX" });
  });

  it("reports a mismatch when the note names a different hash", async () => {
    expect(await checkAnchor(net, "TX", HASH, indexer(noteFor(`sha256:${"cd".repeat(32)}`), 9))).toEqual({ state: "HASH_MISMATCH", txid: "TX" });
  });

  it("separates unconfirmed, not found and indexer outage", async () => {
    expect((await checkAnchor(net, "TX", HASH, indexer(noteFor(HASH), null))).state).toBe("ANCHOR_UNCONFIRMED");
    expect((await checkAnchor(net, "TX", HASH, async () => new Response("", { status: 404 }))).state).toBe("ANCHOR_UNCONFIRMED");
    expect((await checkAnchor(net, null, HASH)).state).toBe("ANCHOR_NOT_FOUND");
    expect((await checkAnchor(net, "TX", HASH, async () => new Response("", { status: 503 }))).state).toBe("INDEXER_UNAVAILABLE");
    expect((await checkAnchor(net, "TX", HASH, async () => { throw new Error("offline"); })).state).toBe("INDEXER_UNAVAILABLE");
  });
});

describe("anchors that never reached a node", () => {
  const failingParams: typeof fetch = async () => new Response("down", { status: 502 });
  const manifestRow = (id: string, hash: string) => ({ id, trip_id: null, kind: "PLAN" as const, hash, status: "ACTIVE" as const, expires_at: null, network: "testnet", signed_json: "{}", now: new Date().toISOString() });

  it("keeps a queued row when the chain call fails before any transaction exists", async () => {
    const store = new TripStore(createTestD1());
    await expect(anchorHash(signer(failingParams), "man_q1", HASH, store)).rejects.toThrow();
    expect(await store.getAnchor("man_q1")).toMatchObject({ state: "QUEUED", txid: null });
  });

  it("puts the anchor back in the queue when the submit never got an answer from a node, but fails one that was rejected", async () => {
    const store = new TripStore(createTestD1());
    const chain = chainFake();
    const flaky: typeof fetch = async (input, init) => (String(input).endsWith("/v2/transactions") && init?.method === "POST" ? new Response("unavailable", { status: 503 }) : chain.fetchFn(input, init));
    await expect(anchorHash(signer(flaky), "man_q2", HASH, store)).rejects.toThrow();
    expect(await store.getAnchor("man_q2")).toMatchObject({ state: "QUEUED", txid: null });

    await expect(anchorHash(signer(chainFake({ rejectSubmit: true }).fetchFn), "man_q3", HASH, store)).rejects.toThrow();
    expect(await store.getAnchor("man_q3")).toMatchObject({ state: "FAILED" });
  });

  it("has the cron submit a queued anchor again from the stored record and then confirm it", async () => {
    const store = new TripStore(createTestD1());
    await store.putManifest(manifestRow("man_q4", HASH));
    await expect(anchorHash(signer(failingParams), "man_q4", HASH, store)).rejects.toThrow();

    const chain = chainFake();
    const resubmit = (id: string, hash: string) => anchorHash({ ...signer(chain.fetchFn), confirmWaitMs: 0 }, id, hash, store);
    expect(await reconcileAnchors(store, net, new Date(), chain.fetchFn, resubmit)).toBe(0);

    const later = new Date(Date.now() + 2 * 60_000);
    expect(await reconcileAnchors(store, net, later, chain.fetchFn, resubmit)).toBe(1);
    expect((await store.getAnchor("man_q4"))?.state).toBe("CONFIRMED");
    expect(chain.submitted).toHaveLength(1);
    expect(new TextDecoder().decode(algosdk.decodeSignedTransaction(chain.submitted[0]!).txn.note)).toBe(noteFor(HASH));
  });

  it("gives up on a queued anchor with no stored record or after an hour", async () => {
    const store = new TripStore(createTestD1());
    const chain = chainFake();
    const resubmit = async () => {
      throw new Error("still down");
    };
    await expect(anchorHash(signer(failingParams), "man_q5", HASH, store)).rejects.toThrow();
    await reconcileAnchors(store, net, new Date(Date.now() + 2 * 60_000), chain.fetchFn, resubmit);
    expect(await store.getAnchor("man_q5")).toMatchObject({ state: "FAILED", error: "no stored record to anchor" });

    await store.putManifest(manifestRow("man_q6", HASH));
    await expect(anchorHash(signer(failingParams), "man_q6", HASH, store)).rejects.toThrow();
    await reconcileAnchors(store, net, new Date(Date.now() + 2 * 60_000), chain.fetchFn, resubmit);
    expect((await store.getAnchor("man_q6"))?.state).toBe("QUEUED");
    await reconcileAnchors(store, net, new Date(Date.now() + 2 * 3600_000), chain.fetchFn, resubmit);
    expect(await store.getAnchor("man_q6")).toMatchObject({ state: "FAILED", error: "could not be submitted within an hour" });
  });
});
