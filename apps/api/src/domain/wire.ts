import type { Environment, SigningKey } from "@intyr/core";
import { signingKeyFromJwkJson } from "@intyr/core";
import type { Env } from "../env";
import type { DomainHandlers } from "./index";
import { createAdapterRegistry } from "./adapters";
import { TripStore } from "./store";
import type { ServiceDeps } from "./service/context";
import { parseCheck, parseIntent, invalid, runCheck, runPrepare, runRevalidate, tripOwner } from "./service/prepare";
import { precheckCommit, reconcileUnknownTrips, runCommit } from "./service/commit";
import type { PaymentSession } from "../payments/sessions";
import { precheckRecover, runRecover } from "./service/recover-route";

const KEY_ID = "intyr-2026-09-a";

async function validSession(store: TripStore, raw: string | undefined, now: Date): Promise<string | undefined> {
  if (!raw) return undefined;
  const s = await store.getSandboxSession(raw);
  return s && Date.parse(s.expires_at) > now.getTime() ? s.id : undefined;
}

/**
 * Wires the domain handlers for one network. A missing signing key leaves every route refusing before any
 * charge, because a manifest nobody can verify is worse than no manifest.
 */
export interface Domain {
  handlers: DomainHandlers;
  /** Resumes commits that paused on an unknown supplier outcome. Returns how many moved. */
  reconcile: () => Promise<number>;
}

export function buildServiceDeps(env: Env, environment: Environment): ServiceDeps | null {
  if (!env.MANIFEST_SIGNING_JWK) return null;
  const key: SigningKey = signingKeyFromJwkJson(KEY_ID, env.MANIFEST_SIGNING_JWK);
  return {
    store: new TripStore(env.DB),
    adapters: createAdapterRegistry(env),
    key,
    environment,
    allowScenario: environment === "TESTNET",
    now: () => new Date(),
  };
}

export function createDomain(env: Env, environment: Environment): Domain {
  const deps = buildServiceDeps(env, environment);
  if (!deps) return { handlers: {}, reconcile: async () => 0 };
  const store = deps.store;

  const sessionForTrip = async (tripId: string): Promise<PaymentSession | null> =>
    env.DB
      .prepare(
        `SELECT p.* FROM payment_sessions p JOIN operations o ON o.session_id = p.id
         WHERE o.trip_id = ?1 AND o.route LIKE '%/trips/commit' ORDER BY o.created_at DESC LIMIT 1`,
      )
      .bind(tripId)
      .first<PaymentSession>();

  const handlers: DomainHandlers = {
    "POST /v1/trips/check": {
      precheck: async (body) => {
        const p = parseCheck(body);
        return p.ok ? null : invalid(p.issues);
      },
      handler: async (ctx) => {
        const p = parseCheck(ctx.body);
        if (!p.ok) return invalid(p.issues);
        return runCheck(p.value, ctx, deps, await validSession(store, ctx.sandboxSessionId, deps.now()));
      },
    },
    "POST /v1/trips/prepare": {
      precheck: async (body) => {
        const p = parseIntent(body);
        if (!p.ok) return invalid(p.issues);
        if (p.value.scenario && !deps.allowScenario) {
          return { status: 422, body: { error: "SCENARIO_NOT_ALLOWED", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], message: "Seeded fault scenarios are accepted on the sandbox host only.", charged: false } };
        }
        return null;
      },
      handler: async (ctx) => {
        const p = parseIntent(ctx.body);
        if (!p.ok) return invalid(p.issues);
        return runPrepare(p.value, ctx, deps, await validSession(store, ctx.sandboxSessionId, deps.now()));
      },
    },
    "POST /v1/trips/revalidate": { handler: (ctx) => runRevalidate(ctx.body, ctx, deps) },
    "POST /v1/trips/commit": {
      precheck: (body) => precheckCommit(body, deps),
      handler: (ctx) => runCommit(ctx.body, ctx, deps),
    },
    "POST /v1/trips/recover": {
      precheck: (body) => precheckRecover(body, deps),
      handler: (ctx) => runRecover(ctx.body, ctx, deps),
    },
  };
  return { handlers, reconcile: () => reconcileUnknownTrips(deps, sessionForTrip) };
}

export { tripOwner };
