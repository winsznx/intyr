import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSigningKey, signTransactionManifest, signingKeyFromJwkJson, type TransactionManifest } from "@intyr/core";
import { KEY_ID } from "../src/domain/wire";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { networkConfig } from "../src/config";
import { reconcileAnchors } from "../src/anchor";
import { TripStore } from "../src/domain/store";
import { createTestD1 } from "./support/d1";

const genesisHash = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A chain that accepts every transaction, confirms it in round 700 and serves it back from its indexer. */
function installChain(): { notes: Map<string, string> } {
  const notes = new Map<string, string>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v2/transactions/params")) return json({ fee: 0, "min-fee": 1000, "last-round": 600, "genesis-id": "testnet-v1.0", "genesis-hash": genesisHash });
    if (url.endsWith("/v2/transactions") && init?.method === "POST") {
      const txn = algosdk.decodeSignedTransaction(init.body as Uint8Array).txn;
      notes.set(txn.txID(), btoa(new TextDecoder().decode(txn.note)));
      return json({ txId: txn.txID() });
    }
    const pending = url.match(/\/v2\/transactions\/pending\/(\w+)$/);
    if (pending) return notes.has(pending[1]!) ? json({ "confirmed-round": 700 }) : json({}, 404);
    const indexed = url.match(/\/v2\/transactions\/(\w+)$/);
    if (indexed && notes.has(indexed[1]!)) return json({ transaction: { note: notes.get(indexed[1]!), "confirmed-round": 700 } });
    return new Response("not found", { status: 404 });
  });
  return { notes };
}

async function anchoredApp() {
  const pair = await generateSigningKey("k");
  const account = algosdk.generateAccount();
  const db = createTestD1();
  const env = {
    DB: db,
    FACILITATOR_URL: "x",
    PAY_TO_TESTNET: "PAYTO",
    MANIFEST_SIGNING_JWK: JSON.stringify(pair.privateJwk),
    ANCHOR_MNEMONIC_TESTNET: algosdk.secretKeyToMnemonic(account.sk),
    ANCHOR_CONFIRM_WAIT_MS: "0",
  } as unknown as Env;
  const net = networkConfig("testnet");
  const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net, payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: {} } });
  const s = await app.request("https://x.test/sandbox/session", { method: "POST" });
  return { app, cookie: s.headers.get("set-cookie")!.split(";")[0]!, db, pair, address: account.addr.toString() };
}

afterEach(() => vi.unstubAllGlobals());

describe("anchored proof", () => {
  it("anchors the transaction manifest and verifies it against the chain note", async () => {
    installChain();
    const { app, cookie } = await anchoredApp();
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy" }) })).json()) as { trip_id: string };
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { final_manifest_id: string; anchor: { state: string; txid: string } };
    expect(trip.anchor.state).toBe("CONFIRMED");

    const stored = (await (await app.request(`https://x.test/sandbox/v1/manifests/${trip.final_manifest_id}`)).json()) as { anchor: { state: string; txid: string; confirmed_round: number; explorer: string } };
    expect(stored.anchor).toMatchObject({ state: "CONFIRMED", txid: trip.anchor.txid, confirmed_round: 700 });
    expect(stored.anchor.explorer).toContain(trip.anchor.txid);

    const verified = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest_id: trip.final_manifest_id }) })).json()) as { proof_state: string; anchor: { state: string; round: number } };
    expect(verified).toMatchObject({ proof_state: "PROOF_VERIFIED", anchor: { state: "ANCHOR_CONFIRMED", round: 700 } });
  });

  it("reports PROOF_PARTIAL for a valid signature that carries no anchor", async () => {
    const { app, cookie } = await anchoredApp();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy" }) })).json()) as { trip_id: string };
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { final_manifest_id: string };
    const verified = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest_id: trip.final_manifest_id }) })).json()) as { proof_state: string; integrity: string };
    expect(verified).toMatchObject({ integrity: "VALID", proof_state: "PROOF_PARTIAL" });
  });
});

describe("pending anchor", () => {
  it("settles into the trip document when the cron later sees the transaction", async () => {
    const chain = installChain();
    const { app, cookie, db } = await anchoredApp();
    const real = globalThis.fetch;
    // The pending poll fails during the request, so the anchor is left PENDING.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/pending/") ? new Response("{}", { status: 404 }) : real(input, init)));
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy", seed: 5 }) })).json()) as { trip_id: string };
    const before = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { anchor: { state: string } };
    expect(before.anchor.state).toBe("PENDING");

    vi.stubGlobal("fetch", real);
    expect(chain.notes.size).toBeGreaterThan(0);
    expect(await reconcileAnchors(new TripStore(db), networkConfig("testnet"), new Date())).toBeGreaterThan(0);
    const after = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { anchor: { state: string; txid: string } };
    expect(after.anchor.state).toBe("CONFIRMED");
  });
});

describe("proof documents", () => {
  it("publishes the anchor account of each configured network and only the contexts the API signs", async () => {
    const { app, address } = await anchoredApp();
    const doc = (await (await app.request("https://x.test/.well-known/intyr-signing-keys.json")).json()) as { anchor_accounts: Record<string, string>; contexts: string[] };
    expect(doc.anchor_accounts).toEqual({ [networkConfig("testnet").caip2]: address });
    expect(doc.contexts).toEqual(["intyr/plan/v1", "intyr/manifest/v1", "intyr/transaction/v1", "intyr/status/v1"]);
  });

  it("reports a correctly signed manifest with a wrong decisions root as HASH_MISMATCH, not a bad signature", async () => {
    installChain();
    const { app, cookie, pair } = await anchoredApp();
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy", seed: 61 }) })).json()) as { trip_id: string };
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { final_manifest_id: string };
    const stored = (await (await app.request(`https://x.test/sandbox/v1/manifests/${trip.final_manifest_id}`)).json()) as { signed: { payload: TransactionManifest } };
    const forged = await signTransactionManifest(signingKeyFromJwkJson(KEY_ID, JSON.stringify(pair.privateJwk)), { ...stored.signed.payload, decisions_root: `sha256:${"0".repeat(64)}` });
    const res = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: forged }) })).json()) as { proof_state: string; reason: string };
    expect(res).toMatchObject({ proof_state: "HASH_MISMATCH", reason: "DECISIONS_ROOT_MISMATCH" });
  });
});

describe("verify across the two hosts", () => {
  async function bothNetworks() {
    const pair = await generateSigningKey("k");
    const account = algosdk.generateAccount();
    const env = {
      DB: createTestD1(),
      FACILITATOR_URL: "x",
      PAY_TO_TESTNET: "PAYTO",
      PAY_TO_MAINNET: "PAYTOM",
      MANIFEST_SIGNING_JWK: JSON.stringify(pair.privateJwk),
      ANCHOR_MNEMONIC_TESTNET: algosdk.secretKeyToMnemonic(account.sk),
      ANCHOR_CONFIRM_WAIT_MS: "0",
    } as unknown as Env;
    const deps = (name: "mainnet" | "testnet") => ({ net: networkConfig(name), payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: {} });
    const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, mainnet: deps("mainnet"), testnet: deps("testnet") });
    const session = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy" }) })).json()) as { trip_id: string };
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { final_manifest_id: string; anchor: { txid: string } };
    const verify = async (prefix: string, body: unknown) => {
      const res = await app.request(`https://x.test${prefix}/manifests/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { app, trip, verify };
  }

  it("refuses a TestNet record on the Mainnet host and names the host that can verify it", async () => {
    installChain();
    const { app, trip, verify } = await bothNetworks();
    const stored = (await (await app.request(`https://x.test/sandbox/v1/manifests/${trip.final_manifest_id}`)).json()) as { signed: unknown };

    expect(await verify("/v1", { manifest_id: trip.final_manifest_id })).toMatchObject({ status: 404, body: { error: "NOT_FOUND" } });
    expect(await verify("/v1", { signed: stored.signed })).toMatchObject({ status: 422, body: { error: "WRONG_NETWORK", verify_at: "/sandbox/v1/manifests/verify" } });
    expect(await verify("/sandbox/v1", { signed: stored.signed })).toMatchObject({ status: 200, body: { proof_state: "PROOF_VERIFIED" } });
  });

  it("verifies by the anchor's transaction id on its own host only", async () => {
    installChain();
    const { trip, verify } = await bothNetworks();
    expect(await verify("/sandbox/v1", { txid: trip.anchor.txid })).toMatchObject({ status: 200, body: { proof_state: "PROOF_VERIFIED", anchor: { txid: trip.anchor.txid } } });
    expect(await verify("/v1", { txid: trip.anchor.txid })).toMatchObject({ status: 404 });
    expect(await verify("/sandbox/v1", { txid: "NOSUCHTXID" })).toMatchObject({ status: 404 });
    expect(await verify("/sandbox/v1", {})).toMatchObject({ status: 422 });
  });
});
