import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./env";
import { TripStore } from "./domain/store";
import { toListItem } from "./domain/trip-doc";

export const SANDBOX_COOKIE = "intyr_sbx";

export interface SandboxSession {
  id: string;
  expires_at: string;
}

/** Reads the session cookie and returns the live session, or null when absent or expired. */
export async function readSession(c: Context, store: TripStore, now: Date): Promise<SandboxSession | null> {
  const id = getCookie(c, SANDBOX_COOKIE);
  if (!id) return null;
  const session = await store.getSandboxSession(id);
  if (!session || Date.parse(session.expires_at) <= now.getTime()) return null;
  return session;
}

export function sessionOwner(session: SandboxSession): string {
  return `session:${session.id}`;
}

/**
 * Anonymous TestNet sandbox sessions. No email, wallet or passkey: a signed-in-free cookie scopes a
 * visitor's trips for 24 hours, and everything in it runs on TestNet against supplier sandboxes or seeded simulators.
 */
export function mountSandbox(app: Hono<{ Bindings: Env }>, deps: { db: D1Database; now?: () => Date }): void {
  const store = new TripStore(deps.db);
  const clock = deps.now ?? (() => new Date());

  app.post("/sandbox/session", async (c) => {
    const existing = await readSession(c, store, clock());
    if (existing) return c.json({ session_id: existing.id, expires_at: existing.expires_at, reused: true });
    const created = await store.createSandboxSession(clock().toISOString());
    setCookie(c, SANDBOX_COOKIE, created.id, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      path: "/",
      maxAge: 24 * 3600,
    });
    return c.json({ session_id: created.id, expires_at: created.expires_at, reused: false }, 201);
  });

  app.delete("/sandbox/session", (c) => {
    deleteCookie(c, SANDBOX_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/sandbox/v1/trips", async (c) => {
    const session = await readSession(c, store, clock());
    if (!session) return c.json({ error: "SESSION_REQUIRED", message: "POST /sandbox/session first." }, 401);
    const rows = await store.listTrips(sessionOwner(session));
    return c.json({ items: rows.map(toListItem) });
  });

  app.get("/sandbox/v1/trips/:id", async (c) => {
    const session = await readSession(c, store, clock());
    if (!session) return c.json({ error: "SESSION_REQUIRED" }, 401);
    const trip = await store.getTrip(c.req.param("id"));
    if (!trip || trip.owner !== sessionOwner(session)) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({
      trip_id: trip.id,
      state: trip.state,
      version: trip.version,
      created_at: trip.created_at,
      updated_at: trip.updated_at,
      ...JSON.parse(trip.doc_json),
      decisions: await store.listDecisions(trip.id),
    });
  });
}
