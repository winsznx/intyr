import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSigningKey } from "@intyr/core";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { networkConfig } from "../src/config";
import { createTestD1 } from "./support/d1";

async function sandboxApp() {
  const pair = await generateSigningKey("k");
  const env = { DB: createTestD1(), FACILITATOR_URL: "x", PAY_TO_TESTNET: "PAYTO", MANIFEST_SIGNING_JWK: JSON.stringify(pair.privateJwk) } as unknown as Env;
  const net = networkConfig("testnet");
  const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net, payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: {} } });
  const s = await app.request("https://x.test/sandbox/session", { method: "POST" });
  return { app, cookie: s.headers.get("set-cookie")!.split(";")[0]! };
}

afterEach(() => vi.unstubAllGlobals());

describe("simulator evidence route", () => {
  it("returns the supplier-side orders for a seed without a session and rejects a malformed seed", async () => {
    const { app, cookie } = await sandboxApp();
    await app.request("https://x.test/sandbox/v1/demo/run", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scenario: "happy", seed: 41 }) });
    const res = await app.request("https://x.test/sandbox/v1/evidence/sim/41/orders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seed: number; orders: Array<{ status: string }> };
    expect(body.seed).toBe(41);
    expect(body.orders.length).toBeGreaterThan(0);
    expect(body.orders.every((o) => o.status === "CONFIRMED")).toBe(true);
    expect((await app.request("https://x.test/sandbox/v1/evidence/sim/abc/orders")).status).toBe(422);
    expect((await (await app.request("https://x.test/sandbox/v1/evidence/sim/99/orders")).json() as { orders: unknown[] }).orders).toEqual([]);
  });
});
