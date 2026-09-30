import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSigningKey } from "@intyr/core";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { networkConfig } from "../src/config";
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
  } as unknown as Env;
  const net = networkConfig("testnet");
  const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net, payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: {} } });
  const s = await app.request("https://x.test/sandbox/session", { method: "POST" });
  return { app, cookie: s.headers.get("set-cookie")!.split(";")[0]!, db };
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
