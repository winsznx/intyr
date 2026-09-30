import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import {
  checkManifestAnchor,
  ChainUnavailableError,
  explorerTxUrl,
  lookupTransaction,
  manifestAnchorNote,
  matchTransfer,
  networkByCaip2,
  NETWORKS,
  preregistrationNote,
  readAssetTransfer,
  submitNoteTransaction,
  type FetchLike,
} from "../src/index";

const NET = { algodUrl: "https://algod.test", indexerUrl: "https://indexer.test" };
const HEX = "ab".repeat(32);
const MANIFEST_HASH = `sha256:${HEX}`;
const TXID = "TXID7777777777777777777777777777777777777777777777777A";
const ACCOUNT = algosdk.generateAccount();
const MNEMONIC = algosdk.secretKeyToMnemonic(ACCOUNT.sk);
const ADDRESS = ACCOUNT.addr.toString();
const OTHER = algosdk.generateAccount().addr.toString();

type Route = (init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes: Record<string, Route>): FetchLike & { posted: Uint8Array[] } {
  const posted: Uint8Array[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (init?.method === "POST" && init.body instanceof Uint8Array) posted.push(init.body);
    const route = routes[key];
    return route ? route(init) : json({ message: "not found" }, 404);
  };
  return Object.assign(fn, { posted });
}

const PARAMS = {
  "GET https://algod.test/v2/transactions/params": () =>
    json({ fee: 0, "min-fee": 1000, "last-round": 5000, "genesis-id": "testnet-v1.0", "genesis-hash": NETWORKS.testnet.genesisHash }),
};

function b64(text: string): string {
  return btoa(text);
}

function indexed(tx: Record<string, unknown>) {
  return { [`GET https://indexer.test/v2/transactions/${TXID}`]: () => json({ "current-round": 6000, transaction: { id: TXID, ...tx } }) };
}

describe("notes", () => {
  it("formats a manifest anchor note from a prefixed hash", () => {
    expect(manifestAnchorNote(MANIFEST_HASH)).toBe(`intyr:v1:${HEX}`);
  });

  it("keeps pre-registration notes distinct from manifest anchors", () => {
    expect(preregistrationNote(HEX)).toBe(`intyr:prereg:v1:${HEX}`);
  });

  it("refuses something that is not a SHA-256 hash", () => {
    expect(() => manifestAnchorNote("sha256:xyz")).toThrow(TypeError);
  });
});

describe("networks", () => {
  it("resolves a network from its x402 CAIP-2 id", () => {
    expect(networkByCaip2("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=")?.name).toBe("testnet");
  });

  it("links a transaction to the public explorer", () => {
    expect(explorerTxUrl(NETWORKS.mainnet, TXID)).toBe(`https://allo.info/tx/${TXID}`);
  });
});

describe("submitNoteTransaction", () => {
  it("sends a 0-ALGO self payment carrying the note, at the minimum fee", async () => {
    // #given a node whose per-byte fee is 0, the usual case
    const fetchFn = fakeFetch({ ...PARAMS, "POST https://algod.test/v2/transactions": () => json({ txId: "ignored" }) });

    // #when an anchor note is submitted
    const result = await submitNoteTransaction(NET, { mnemonic: MNEMONIC }, manifestAnchorNote(MANIFEST_HASH), { fetch: fetchFn });

    // #then the posted transaction is exactly what the result describes
    const sent = algosdk.decodeSignedTransaction(fetchFn.posted[0]!).txn;
    expect({
      state: result.state,
      txid: result.txid === sent.txID(),
      sender: sent.sender.toString(),
      receiver: sent.payment?.receiver.toString(),
      amount: sent.payment?.amount,
      fee: sent.fee,
      note: new TextDecoder().decode(sent.note),
      validity: [sent.firstValid, sent.lastValid],
    }).toEqual({
      state: "ACCEPTED",
      txid: true,
      sender: ADDRESS,
      receiver: ADDRESS,
      amount: 0n,
      fee: 1000n,
      note: `intyr:v1:${HEX}`,
      validity: [5000n, 5100n],
    });
  });

  it("reports a lost response as UNKNOWN with the txid to reconcile by", async () => {
    const fetchFn = fakeFetch({
      ...PARAMS,
      "POST https://algod.test/v2/transactions": () => {
        throw new TypeError("network connection lost");
      },
    });
    const result = await submitNoteTransaction(NET, { mnemonic: MNEMONIC }, "intyr:test", { fetch: fetchFn });
    expect([result.state, result.txid.length]).toEqual(["UNKNOWN", 52]);
  });

  it("reports a node failure as UNKNOWN rather than as a rejection", async () => {
    const fetchFn = fakeFetch({ ...PARAMS, "POST https://algod.test/v2/transactions": () => json({ message: "busy" }, 503) });
    expect((await submitNoteTransaction(NET, { mnemonic: MNEMONIC }, "intyr:test", { fetch: fetchFn })).state).toBe("UNKNOWN");
  });

  it("reports a refused transaction as REJECTED", async () => {
    const fetchFn = fakeFetch({ ...PARAMS, "POST https://algod.test/v2/transactions": () => json({ message: "overspend" }, 400) });
    expect((await submitNoteTransaction(NET, { mnemonic: MNEMONIC }, "intyr:test", { fetch: fetchFn })).state).toBe("REJECTED");
  });

  it("throws before sending anything when the node cannot give parameters", async () => {
    const fetchFn = fakeFetch({});
    await expect(submitNoteTransaction(NET, { mnemonic: MNEMONIC }, "intyr:test", { fetch: fetchFn })).rejects.toThrow(
      ChainUnavailableError,
    );
  });

  it("refuses a note over the protocol limit", async () => {
    const fetchFn = fakeFetch(PARAMS);
    await expect(submitNoteTransaction(NET, { mnemonic: MNEMONIC }, "x".repeat(1025), { fetch: fetchFn })).rejects.toThrow(RangeError);
  });
});

describe("lookupTransaction", () => {
  it("reads confirmation from the node's pending pool first", async () => {
    const fetchFn = fakeFetch({ [`GET https://algod.test/v2/transactions/pending/${TXID}`]: () => json({ "confirmed-round": 5003 }) });
    expect(await lookupTransaction(NET, TXID, fetchFn)).toEqual({ state: "CONFIRMED", round: 5003, source: "algod" });
  });

  it("reports a pooled, unconfirmed transaction as PENDING", async () => {
    const fetchFn = fakeFetch({ [`GET https://algod.test/v2/transactions/pending/${TXID}`]: () => json({ "pool-error": "" }) });
    expect(await lookupTransaction(NET, TXID, fetchFn)).toEqual({ state: "PENDING" });
  });

  it("reports a transaction the pool evicted as DROPPED", async () => {
    const fetchFn = fakeFetch({ [`GET https://algod.test/v2/transactions/pending/${TXID}`]: () => json({ "pool-error": "txn dead" }) });
    expect(await lookupTransaction(NET, TXID, fetchFn)).toEqual({ state: "DROPPED", reason: "txn dead" });
  });

  it("falls back to the indexer for an older transaction", async () => {
    const fetchFn = fakeFetch(indexed({ "confirmed-round": 4100, sender: ADDRESS }));
    expect(await lookupTransaction(NET, TXID, fetchFn)).toEqual({ state: "CONFIRMED", round: 4100, source: "indexer" });
  });

  it("returns the current round with NOT_FOUND so the caller can judge finality", async () => {
    const fetchFn = fakeFetch({ "GET https://algod.test/v2/status": () => json({ "last-round": 5200 }) });
    expect(await lookupTransaction(NET, TXID, fetchFn)).toEqual({ state: "NOT_FOUND", currentRound: 5200 });
  });

  it("reports UNAVAILABLE when neither node nor indexer answers", async () => {
    const fetchFn: FetchLike = async () => new Response("down", { status: 502 });
    expect((await lookupTransaction(NET, TXID, fetchFn)).state).toBe("UNAVAILABLE");
  });
});

describe("checkManifestAnchor", () => {
  const anchored = { "confirmed-round": 4100, sender: ADDRESS, "tx-type": "pay", note: b64(`intyr:v1:${HEX}`) };

  it("confirms an indexed anchor whose note carries the manifest hash from the anchor account", async () => {
    const fetchFn = fakeFetch(indexed(anchored));
    expect(await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { anchorAddress: ADDRESS, fetch: fetchFn })).toEqual({
      state: "ANCHOR_CONFIRMED",
      txid: TXID,
      round: 4100,
      sender: ADDRESS,
    });
  });

  it("reports a note for a different manifest as a hash mismatch", async () => {
    const fetchFn = fakeFetch(indexed({ ...anchored, note: b64(`intyr:v1:${"cd".repeat(32)}`) }));
    expect((await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { fetch: fetchFn })).state).toBe("HASH_MISMATCH");
  });

  it("rejects a matching note sent by someone other than the anchor account", async () => {
    const fetchFn = fakeFetch(indexed({ ...anchored, sender: OTHER }));
    expect((await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { anchorAddress: ADDRESS, fetch: fetchFn })).state).toBe(
      "ANCHOR_WRONG_SENDER",
    );
  });

  it("reports an anchor the node holds but the indexer has not seen as unconfirmed", async () => {
    const fetchFn = fakeFetch({ [`GET https://algod.test/v2/transactions/pending/${TXID}`]: () => json({ "pool-error": "" }) });
    expect((await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { fetch: fetchFn })).state).toBe("ANCHOR_UNCONFIRMED");
  });

  it("reports an anchor nobody knows as not found", async () => {
    expect((await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { fetch: fakeFetch({}) })).state).toBe("ANCHOR_NOT_FOUND");
  });

  it("reports an indexer outage instead of guessing", async () => {
    const fetchFn = fakeFetch({ [`GET https://indexer.test/v2/transactions/${TXID}`]: () => json({}, 500) });
    expect((await checkManifestAnchor(NET, TXID, MANIFEST_HASH, { fetch: fetchFn })).state).toBe("INDEXER_UNAVAILABLE");
  });
});

describe("readAssetTransfer", () => {
  const usdc = {
    "confirmed-round": 4100,
    sender: OTHER,
    "tx-type": "axfer",
    group: "R1JPVVA=",
    "asset-transfer-transaction": { amount: 10_000, "asset-id": 10458941, receiver: ADDRESS },
  };

  it("reads an indexed USDC transfer", async () => {
    const read = await readAssetTransfer(NET, TXID, fakeFetch(indexed(usdc)));
    expect(read).toEqual({
      state: "CONFIRMED",
      transfer: { txid: TXID, round: 4100, sender: OTHER, receiver: ADDRESS, assetId: 10458941, amount: 10_000, group: "R1JPVVA=", source: "indexer" },
    });
  });

  it("covers indexing lag from the node's pending pool", async () => {
    const raw = {
      type: "axfer",
      snd: btoa(String.fromCharCode(...algosdk.decodeAddress(OTHER).publicKey)),
      arcv: btoa(String.fromCharCode(...algosdk.decodeAddress(ADDRESS).publicKey)),
      xaid: 10458941,
      aamt: 10_000,
    };
    const fetchFn = fakeFetch({
      [`GET https://algod.test/v2/transactions/pending/${TXID}`]: () => json({ "confirmed-round": 5003, txn: { txn: raw } }),
    });
    const read = await readAssetTransfer(NET, TXID, fetchFn);
    expect(read.state === "CONFIRMED" ? [read.transfer.sender, read.transfer.receiver, read.transfer.source] : read).toEqual([
      OTHER,
      ADDRESS,
      "algod",
    ]);
  });

  it("refuses to treat a plain payment as a transfer", async () => {
    const read = await readAssetTransfer(NET, TXID, fakeFetch(indexed({ "confirmed-round": 1, sender: OTHER, "tx-type": "pay" })));
    expect(read).toEqual({ state: "NOT_A_TRANSFER", txType: "pay" });
  });
});

describe("matchTransfer", () => {
  const transfer = { txid: TXID, round: 1, sender: OTHER, receiver: ADDRESS, assetId: 10458941, amount: 10_000, group: null, source: "indexer" as const };

  it.each([
    { name: "a matching transfer", expected: { assetId: 10458941, receiver: ADDRESS, amount: 10_000, sender: OTHER }, result: { ok: true } },
    { name: "another asset", expected: { assetId: 31566704, receiver: ADDRESS, amount: 10_000 }, result: { ok: false, reason: "WRONG_ASSET" } },
    { name: "another receiver", expected: { assetId: 10458941, receiver: OTHER, amount: 10_000 }, result: { ok: false, reason: "WRONG_RECEIVER" } },
    { name: "another amount", expected: { assetId: 10458941, receiver: ADDRESS, amount: 9_999 }, result: { ok: false, reason: "WRONG_AMOUNT" } },
    { name: "another payer", expected: { assetId: 10458941, receiver: ADDRESS, amount: 10_000, sender: ADDRESS }, result: { ok: false, reason: "WRONG_SENDER" } },
  ])("judges $name", ({ expected, result }) => {
    expect(matchTransfer(transfer, expected)).toEqual(result);
  });
});
