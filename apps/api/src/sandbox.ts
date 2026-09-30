import { SimulatorAdapter } from "@intyr/adapters";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Env } from "./env";
import { TripStore } from "./domain/store";
import { toListItem, type TripDoc } from "./domain/trip-doc";
import type { ServiceDeps } from "./domain/service/context";
import { parseIntent, runPrepare } from "./domain/service/prepare";
import { runCommit } from "./domain/service/commit";
import { updateTripDoc } from "./domain/service/trip-update";
import type { PaidContext } from "./payments/ladder";

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

// ---------------------------------------------------------------- approvals and demo runs


const ApproveBodySchema = z.object({
  manifest_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(280).optional(),
});

export const DEMO_SCENARIOS = {
  happy: { label: "Everything confirms", min_readiness: 30, faults: [] as Array<{ component_index: number; fault: string }> },
  "rejected-flight": { label: "The flight is rejected after the hotel and transfer confirmed", min_readiness: 30, faults: [{ component_index: 1, fault: "COMMIT_REJECT" }] },
  "timeout-hotel": { label: "The hotel times out: booked or not, unknown", min_readiness: 30, faults: [{ component_index: 0, fault: "TIMEOUT_BOOKED" }] },
  "refuse-irreversible": { label: "A non-refundable flight drops readiness below the threshold: Intyr refuses and books nothing", min_readiness: 30, faults: [{ component_index: 1, fault: "NON_REFUNDABLE" }] },
} as const;

const DEMO_IDS = ["happy", "rejected-flight", "timeout-hotel", "refuse-irreversible"] as const;

const DemoBodySchema = z.object({
  scenario: z.enum(DEMO_IDS).default("rejected-flight"),
  seed: z.number().int().nonnegative().max(2 ** 31 - 1).optional(),
});

/** A fresh seed per run. The simulator keeps its state per seed, so two runs sharing one would see each other's offers and orders. */
function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** 31;
}

function sandboxCtx(sessionId: string, operationId: string): PaidContext {
  return { network: "testnet", sponsored: true, sandboxSessionId: sessionId, body: {}, session: null, operationId, now: new Date().toISOString() };
}

export function mountSandboxActions(app: Hono<{ Bindings: Env }>, deps: { db: D1Database; service: () => ServiceDeps | null; now?: () => Date }): void {
  const store = new TripStore(deps.db);
  const clock = deps.now ?? (() => new Date());

  app.post("/sandbox/v1/trips/:id/approve", async (c) => {
    const session = await readSession(c, store, clock());
    if (!session) return c.json({ error: "SESSION_REQUIRED" }, 401);
    const trip = await store.getTrip(c.req.param("id"));
    if (!trip || trip.owner !== sessionOwner(session)) return c.json({ error: "NOT_FOUND" }, 404);
    const parsed = ApproveBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
    const doc = JSON.parse(trip.doc_json) as TripDoc;
    const now = clock();
    if (parsed.data.manifest_hash !== doc.manifest_hash) {
      return c.json({ error: "MANIFEST_HASH_MISMATCH", message: "The manifest changed while you were reviewing it.", current_manifest: { manifest_id: doc.manifest_id, manifest_hash: doc.manifest_hash, expires_at: doc.deadline } }, 409);
    }
    if (doc.deadline && Date.parse(doc.deadline) <= now.getTime()) {
      return c.json({ error: "APPROVAL_EXPIRED", message: "This manifest has expired. Revalidate to get a fresh one.", current_manifest: { manifest_id: doc.manifest_id, manifest_hash: doc.manifest_hash, expires_at: doc.deadline } }, 409);
    }
    const approvalId = await store.putApproval({ trip_id: trip.id, manifest_hash: parsed.data.manifest_hash, decision: parsed.data.decision, actor: `session:${session.id}`, ...(parsed.data.note ? { note: parsed.data.note } : {}), now: now.toISOString() });
    await updateTripDoc(store, trip.id, now.toISOString(), (d) => {
      if (parsed.data.decision === "APPROVE") {
        d.next_actions = [{ action: "COMMIT", allowed: true, ...(d.deadline ? { recommended_before: d.deadline } : {}) }];
      } else {
        d.next_actions = [{ action: "PREPARE", allowed: true }, { action: "COMMIT", allowed: false, reason: "APPROVAL_INVALID" }];
      }
    });
    return c.json({ approval_id: approvalId, decision: parsed.data.decision, manifest_hash: parsed.data.manifest_hash, approved_by: "SESSION_APPROVER" });
  });

  app.get("/sandbox/v1/evidence/sim/:seed/orders", async (c) => {
    const seed = Number(c.req.param("seed"));
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) return c.json({ error: "INVALID_REQUEST", message: "seed must be an integer between 0 and 2147483647." }, 422);
    const service = deps.service();
    if (!service) return c.json({ error: "NOT_AVAILABLE", message: "The signing key is not configured." }, 503);
    const simulator = service.adapters.all().find((a): a is SimulatorAdapter => a instanceof SimulatorAdapter);
    if (!simulator) return c.json({ error: "NOT_AVAILABLE" }, 503);
    return c.json({ seed, orders: await simulator.auditOrders(String(seed)) });
  });

  app.get("/sandbox/v1/demo/scenarios", (c) => c.json({ items: Object.entries(DEMO_SCENARIOS).map(([id, s]) => ({ id, label: s.label })) }));

  app.post("/sandbox/v1/demo/run", async (c) => {
    const session = await readSession(c, store, clock());
    if (!session) return c.json({ error: "SESSION_REQUIRED", message: "POST /sandbox/session first." }, 401);
    const service = deps.service();
    if (!service) return c.json({ error: "NOT_AVAILABLE", message: "The signing key is not configured." }, 503);
    const parsed = DemoBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 422);
    const { scenario } = parsed.data;
    const seed = parsed.data.seed ?? freshSeed();
    const since = new Date(clock().getTime() - 3600_000).toISOString();
    const used = await deps.db.prepare("SELECT COUNT(*) AS n FROM sponsored_calls WHERE sandbox_session_id = ?1 AND at >= ?2").bind(session.id, since).first<{ n: number }>();
    if ((used?.n ?? 0) >= 40) return c.json({ error: "RATE_LIMITED", message: "Demo runs are limited per hour." }, 429);

    const intent = {
      trip_ref: `demo-${scenario}`,
      currency: "USD",
      budget_total_minor: 200_000,
      components: [
        { type: "HOTEL", city: "London", check_in: "2026-11-01", check_out: "2026-11-03", guests: 1 },
        { type: "FLIGHT", origin: "JFK", destination: "LHR", depart_date: "2026-11-01", passengers: 1 },
        { type: "GROUND", from: "LHR", to: "Central London", pickup_at: "2026-11-01T18:00:00Z", passengers: 1 },
      ],
      limits: { min_readiness: DEMO_SCENARIOS[scenario].min_readiness },
      scenario: { seed, faults: DEMO_SCENARIOS[scenario].faults },
    };
    const p = parseIntent(intent);
    if (!p.ok) return c.json({ error: "INTERNAL_ERROR", issues: p.issues }, 500);
    await deps.db.prepare("INSERT INTO sponsored_calls (sandbox_session_id, route, operation_id, at) VALUES (?1,?2,?3,?4)").bind(session.id, "demo/run", `demo_${scenario}`, clock().toISOString()).run();
    const prep = await runPrepare(p.value, sandboxCtx(session.id, `demo_prepare_${seed}`), service, session.id);
    if (!prep.tripId || prep.status !== 200 || !prep.body.manifest_id) return c.json({ run_id: prep.tripId ?? null, scenario, prepared: prep.body }, prep.status as 200);
    const commitBody = {
      trip_id: prep.tripId,
      manifest_id: prep.body.manifest_id as string,
      manifest_hash: prep.body.manifest_hash as string,
      maximum_total_minor: 1_000_000,
      currency: "USD",
      recovery_policy_acknowledged: true as const,
    };
    const commit = await runCommit(commitBody, sandboxCtx(session.id, `demo_commit_${seed}`), service);
    return c.json({ run_id: prep.tripId, trip_id: prep.tripId, scenario, seed, label: DEMO_SCENARIOS[scenario].label, final_state: commit.body.state, outcome: commit.body.outcome, note: "Sandbox run. Suppliers are seeded simulators. No USDC moved." });
  });
}
