import { readBodyWithLimit } from "./body";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { canonicalize, hashValue, newId, sha256Hex } from "@intyr/core";
import type { Env } from "./env";
import type { PaidRoute } from "./payments/ladder";
import { completeOperation, createOperation } from "./payments/sessions";
import { SANDBOX_COOKIE } from "./sandbox";
import { TripStore } from "./domain/store";

export const SPONSORED_LIMIT_PER_HOUR = 60;

/** True when the request carries a live sandbox cookie and no payment proof: the server sponsors the call. */
export async function sponsoredSession(c: Context, store: TripStore, now: Date): Promise<string | null> {
  if (c.req.header("payment-signature") || c.req.header("x-payment")) return null;
  const id = getCookie(c, SANDBOX_COOKIE);
  if (!id) return null;
  const session = await store.getSandboxSession(id);
  return session && Date.parse(session.expires_at) > now.getTime() ? session.id : null;
}

/**
 * A sandbox call under a cookie session, paid for by the server. It runs the same gate, handler and saga as a
 * paid call, on TestNet against supplier sandboxes and seeded simulators. No USDC moves, and the response says so:
 * payment_state is SPONSORED and there is no payment txid. It never exists on Mainnet.
 */
export async function runSponsored(
  c: Context,
  route: PaidRoute,
  deps: { db: D1Database; sandboxSessionId: string; now?: () => Date },
): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const read = await readBodyWithLimit(c);
  if (!read.ok) return read.response;
  const raw = read.raw;
  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
    await hashValue(canonicalize(body));
  } catch {
    return c.json({ error: "INVALID_REQUEST", message: "Body must be JSON." }, 400);
  }

  const since = new Date(now.getTime() - 3600_000).toISOString();
  const used = await deps.db
    .prepare("SELECT COUNT(*) AS n FROM sponsored_calls WHERE sandbox_session_id = ?1 AND at >= ?2")
    .bind(deps.sandboxSessionId, since)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= SPONSORED_LIMIT_PER_HOUR) {
    return c.json({ error: "RATE_LIMITED", message: "Sandbox sessions are limited to 60 sponsored calls per hour.", payment_state: "SPONSORED", charged: false }, 429);
  }

  if (route.precheck) {
    const refused = await route.precheck(body);
    if (refused) return c.json({ ...refused.body, payment_state: "SPONSORED", payment_txid: null, charged: false }, refused.status as 400);
  }

  const opKey = `sponsored_${(await sha256Hex(newId("ops"))).slice(0, 24)}`;
  const { operation } = await createOperation(deps.db, opKey, route.key, now.toISOString());
  await deps.db
    .prepare("INSERT INTO sponsored_calls (sandbox_session_id, route, operation_id, at) VALUES (?1,?2,?3,?4)")
    .bind(deps.sandboxSessionId, route.key, operation.id, now.toISOString())
    .run();

  try {
    const result = await route.handler({ network: "testnet", sponsored: true, sandboxSessionId: deps.sandboxSessionId, body, session: null, operationId: operation.id, now: now.toISOString() });
    const out = { ...result.body, operation_id: operation.id, payment_state: "SPONSORED", payment_txid: null, sponsored: true, note: "Sandbox call sponsored by the server. No USDC moved." };
    await completeOperation(deps.db, operation.id, "DONE", result.status, out, result.tripId ?? null, new Date().toISOString());
    return c.json(out, result.status as 200);
  } catch (e) {
    const out = { error: "INTERNAL_ERROR", operation_id: operation.id, payment_state: "SPONSORED", payment_txid: null, message: "The operation failed. Nothing was charged." };
    await completeOperation(deps.db, operation.id, "FAILED", 500, { ...out, detail: e instanceof Error ? e.message : String(e) }, null, new Date().toISOString());
    return c.json(out, 500);
  }
}

export type { Hono, Env };
