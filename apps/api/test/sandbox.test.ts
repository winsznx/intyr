import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import { createTestD1 } from "./support/d1";
import { SESSIONS_PER_CLIENT_PER_HOUR, mountSandbox } from "../src/sandbox";
import { TripStore } from "../src/domain/store";

function setup() {
  const db = createTestD1();
  const app = new Hono<{ Bindings: Env }>();
  mountSandbox(app, { db });
  return { app, db, store: new TripStore(db) };
}

describe("sandbox sessions", () => {
  it("creates an HttpOnly cookie session and reuses it", async () => {
    const { app } = setup();
    const res = await app.request("https://x.test/sandbox/session", { method: "POST" });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("intyr_sbx=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    const again = await app.request("https://x.test/sandbox/session", { method: "POST", headers: { cookie: cookie.split(";")[0]! } });
    expect(((await again.json()) as { reused: boolean }).reused).toBe(true);
  });

  it("limits how many sessions one address can open in an hour, without counting a reused session or another address", async () => {
    const { app } = setup();
    const open = (ip: string, cookie?: string) => app.request("https://x.test/sandbox/session", { method: "POST", headers: { "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}) } });
    let first: Response | undefined;
    for (let i = 0; i < SESSIONS_PER_CLIENT_PER_HOUR; i++) {
      const res = await open("203.0.113.9");
      expect(res.status).toBe(201);
      first ??= res;
    }
    const blocked = await open("203.0.113.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    expect(await blocked.json()).toMatchObject({ error: "RATE_LIMITED" });

    expect((await open("203.0.113.10")).status).toBe(201);
    const reused = await open("203.0.113.9", first!.headers.get("set-cookie")!.split(";")[0]!);
    expect(reused.status).toBe(200);
    expect(((await reused.json()) as { reused: boolean }).reused).toBe(true);
  });

  it("lists only the trips of the calling session, newest first", async () => {
    const { app, store } = setup();
    const a = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const b = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const cookieA = a.headers.get("set-cookie")!.split(";")[0]!;
    const cookieB = b.headers.get("set-cookie")!.split(";")[0]!;
    const idA = cookieA.split("=")[1]!;
    const doc = { currency: "USD", components: [], next_actions: [], deadline: null };
    await store.createTrip({ network: "testnet", owner: `session:${idA}`, state: "PREPARED", currency: "USD", total_minor: 100, doc, now: "2026-10-01T00:00:00.000Z" });
    await store.createTrip({ network: "testnet", owner: `session:${idA}`, state: "CHECKED", currency: "USD", total_minor: 200, doc, now: "2026-10-01T00:00:01.000Z" });
    const listA = (await (await app.request("https://x.test/sandbox/v1/trips", { headers: { cookie: cookieA } })).json()) as { items: Array<{ state: string }> };
    expect(listA.items.map((i) => i.state)).toEqual(["CHECKED", "PREPARED"]);
    const listB = (await (await app.request("https://x.test/sandbox/v1/trips", { headers: { cookie: cookieB } })).json()) as { items: unknown[] };
    expect(listB.items).toHaveLength(0);
    const anon = await app.request("https://x.test/sandbox/v1/trips");
    expect(anon.status).toBe(401);
  });

  it("does not reveal another session's trip", async () => {
    const { app, store } = setup();
    const a = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const b = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const idA = a.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const trip = await store.createTrip({ network: "testnet", owner: `session:${idA}`, state: "PREPARED", doc: { components: [], next_actions: [] }, now: "2026-10-01T00:00:00.000Z" });
    const res = await app.request(`https://x.test/sandbox/v1/trips/${trip.id}`, { headers: { cookie: b.headers.get("set-cookie")!.split(";")[0]! } });
    expect(res.status).toBe(404);
  });
});

import { generateSigningKey, signingKeyFromJwkJson } from "@intyr/core";
import { createApp } from "../src/app";

async function appWithService() {
  const db = createTestD1();
  const pair = await generateSigningKey("k");
  const env = { DB: db, FACILITATOR_URL: "x", PAY_TO_TESTNET: "PAYTO", MANIFEST_SIGNING_JWK: JSON.stringify(pair.privateJwk) } as unknown as Env;
  // Domain handlers are not needed for sandbox actions, which call the services directly.
  const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net: { name: "testnet", caip2: "x", usdcAssetId: "1", algodUrl: "", indexerUrl: "", explorerTx: () => "" }, payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: {} } });
  const s = await app.request("https://x.test/sandbox/session", { method: "POST" });
  const cookie = s.headers.get("set-cookie")!.split(";")[0]!;
  return { app, cookie, db };
}

describe("sandbox demo and approval", () => {
  it("runs the seeded rejected-flight scenario end to end and ends RECOVERED", async () => {
    const { app, cookie } = await appWithService();
    const res = await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "rejected-flight" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { final_state: string; trip_id: string };
    expect(body.final_state).toBe("RECOVERED");
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${body.trip_id}`, { headers: { cookie } })).json()) as { state: string; decisions: Array<{ gate: string }> };
    expect(trip.state).toBe("RECOVERED");
    expect(trip.decisions.some((d) => d.gate === "RECOVERY_ACTION")).toBe(true);
    const list = (await (await app.request("https://x.test/sandbox/v1/trips", { headers: { cookie } })).json()) as { items: Array<{ trip_id: string }> };
    expect(list.items.map((i) => i.trip_id)).toContain(body.trip_id);
  });

  it("gives every demo run its own seed, so runs never share simulator state, and pauses a timed-out hotel as unknown", async () => {
    const { app, cookie } = await appWithService();
    const run = async (scenario: string) =>
      (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario }) })).json()) as { seed: number; final_state: string };
    const first = await run("timeout-hotel");
    const second = await run("rejected-flight");
    expect(first.seed).not.toBe(second.seed);
    expect(first.final_state).toBe("COMMIT_STATUS_UNKNOWN");
    expect(second.final_state).toBe("RECOVERED");
    const explicit = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy", seed: 123 }) })).json()) as { seed: number };
    expect(explicit.seed).toBe(123);
  });

  it("requires a session for demo runs and refuses a stale approval hash with the current manifest", async () => {
    const { app, cookie } = await appWithService();
    const anon = await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST" });
    expect(anon.status).toBe(401);
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy" }) })).json()) as { trip_id: string };
    const stale = await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}/approve`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ manifest_hash: "sha256:" + "1".repeat(64), decision: "APPROVE" }) });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; current_manifest: { manifest_hash: string } };
    expect(body.error).toBe("MANIFEST_HASH_MISMATCH");
    expect(body.current_manifest.manifest_hash).toMatch(/^sha256:/);
  });
});

describe("proof routes", () => {
  it("serves the public key, verifies a stored manifest signature without an anchor, then rejects a tampered copy", async () => {
    const { app, cookie } = await appWithService();
    const keys = (await (await app.request("https://x.test/.well-known/intyr-signing-keys.json")).json()) as { keys: Array<{ public_key: string }> };
    expect(keys.keys).toHaveLength(1);
    const run = (await (await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy" }) })).json()) as { trip_id: string };
    const trip = (await (await app.request(`https://x.test/sandbox/v1/trips/${run.trip_id}`, { headers: { cookie } })).json()) as { final_manifest_id: string };
    const good = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest_id: trip.final_manifest_id }) })).json()) as { proof_state: string; integrity: string; anchor: { state: string } };
    expect(good).toMatchObject({ integrity: "VALID", proof_state: "PROOF_PARTIAL", anchor: { state: "ANCHOR_NOT_FOUND" } });
    const stored = (await (await app.request(`https://x.test/sandbox/v1/manifests/${trip.final_manifest_id}`)).json()) as { signed: { payload: { stranded_spend_minor: number } } };
    stored.signed.payload.stranded_spend_minor = 999;
    const bad = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: stored.signed }) })).json()) as { proof_state: string };
    expect(bad.proof_state).toBe("HASH_MISMATCH");
  });
});
