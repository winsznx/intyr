import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import { createTestD1 } from "./support/d1";
import { mountSandbox } from "../src/sandbox";
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
