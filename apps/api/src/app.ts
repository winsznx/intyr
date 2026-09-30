import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { CHALLENGE_TAG, routePrefix, type NetworkConfig } from "./config";
import { ROUTE_PRICES, atomicToUsdc } from "./prices";
import type { Ladder, PaidRoute } from "./payments/ladder";
import { getOperation, getSessionById } from "./payments/sessions";
import { notAvailable, type DomainHandlers, type RouteKey } from "./domain";
import { mountSandbox, mountSandboxActions } from "./sandbox";
import { KEY_ID, KEY_VALID_FROM, buildServiceDeps } from "./domain/wire";
import { integrityProofState, publishedKey, signingKeyFromJwkJson, verifyManifestDocument, type PublishedKey, type Signed, type SignedRecord } from "@intyr/core";
import { runSponsored, sponsoredSession } from "./sponsored";
import { TripStore } from "./domain/store";
import { checkAnchor } from "./anchor";
import { anchorAccounts } from "./anchor-accounts";
import { getRefundBySession, summarize } from "./payments/refunds";

export interface NetworkDeps {
  net: NetworkConfig;
  payTo: string;
  ladder: Ladder;
  domain: DomainHandlers;
}

export interface AppDeps {
  env: Env;
  /** Mainnet serves /v1 and is the only network registered in the Bazaar. TestNet serves /sandbox/v1. */
  mainnet?: NetworkDeps;
  testnet?: NetworkDeps;
  version: { name: string; commit: string; contract_versions: Record<string, string> };
}

export function buildPaidRoutes(domain: DomainHandlers, prefix: string): PaidRoute[] {
  return ROUTE_PRICES.map((p) => {
    const d = domain[p.key as RouteKey];
    return {
      key: `POST ${prefix}${p.path.slice("/v1".length)}`,
      amountAtomic: p.amountAtomic,
      requireChainConfirmation: p.requires_chain_confirmation,
      ...(d ? {} : { unavailable: notAvailable(p.key) }),
      ...(d?.precheck ? { precheck: d.precheck } : {}),
      handler: d?.handler ?? (async () => notAvailable(p.key)),
    };
  });
}

function pricesPayload(n: NetworkDeps) {
  const prefix = routePrefix(n.net.name);
  return {
    environment: n.net.name.toUpperCase(),
    network: n.net.caip2,
    asset: n.net.usdcAssetId,
    pay_to: n.payTo,
    tag: CHALLENGE_TAG,
    note: "Exact-amount x402 payments in USDC. Prices are initial assumptions and are reviewed against measured usage.",
    routes: ROUTE_PRICES.map((p) => ({
      method: "POST",
      path: `${prefix}${p.path.slice("/v1".length)}`,
      name: p.name,
      price_usdc: atomicToUsdc(p.amountAtomic),
      price_atomic: p.amountAtomic,
      unique_output: p.unique_output,
      fee_disposition: p.fee_disposition,
      requires_chain_confirmation: p.requires_chain_confirmation,
    })),
  };
}

function publishedKeys(env: Env): PublishedKey[] {
  if (!env.MANIFEST_SIGNING_JWK) return [];
  return [publishedKey(signingKeyFromJwkJson(KEY_ID, env.MANIFEST_SIGNING_JWK), KEY_VALID_FROM)];
}

const VERIFY_NOTE = "Integrity and timing only. This does not prove the supplier told the truth.";

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const db = deps.env.DB;

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["content-type", "payment-signature", "x-payment", "idempotency-key"],
      exposeHeaders: ["payment-required", "payment-response", "x-payment-response", "intyr-replay"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  const store = new TripStore(db);
  const primary = deps.mainnet ?? deps.testnet;
  if (deps.testnet) {
    mountSandbox(app, { db });
    let service: ReturnType<typeof buildServiceDeps> | undefined;
    mountSandboxActions(app, { db, service: () => (service ??= buildServiceDeps(deps.env, "TESTNET")) });
  }
  const nets: NetworkDeps[] = [deps.mainnet, deps.testnet].filter((n): n is NetworkDeps => Boolean(n));

  for (const n of nets) {
    const prefix = routePrefix(n.net.name);
    for (const route of buildPaidRoutes(n.domain, prefix)) {
      const path = route.key.split(" ")[1]!;
      if (n.net.name === "testnet") {
        // A live sandbox cookie without a payment proof is sponsored by the server. Anything else pays through x402.
        app.post(path, async (c) => {
          const sid = await sponsoredSession(c, store, new Date());
          return sid ? runSponsored(c, route, { db, sandboxSessionId: sid }) : n.ladder(c, route);
        });
      } else {
        app.post(path, (c) => n.ladder(c, route));
      }
    }
    app.get(`${prefix}/prices`, (c) => c.json(pricesPayload(n)));
    app.get(`${prefix}/capabilities`, (c) =>
      c.json({
        product: "Intyr",
        environment: n.net.name.toUpperCase(),
        entry_type: "composite",
        assurance: { mode: "NONE" },
        leg_classes: ["CALLER_SUPPLIED", "SUPPLIER_SANDBOX", "SIMULATED"],
        preparation_modes: ["HARD_HOLD", "SOFT_HOLD", "REVALIDATED", "INSTANT_COMMIT_ONLY", "UNSUPPORTED"],
        decision_outcomes: ["ACT", "NO_ACTION", "UNKNOWN", "REFUSE", "MANUAL_REVIEW"],
        routes: pricesPayload(n).routes,
        limits: ["Suppliers in this release are supplier sandboxes, caller-supplied offers or seeded simulators, and every leg says which."],
      }),
    );
    app.get(`${prefix}/payments/:id`, async (c) => {
      const s = await getSessionById(db, c.req.param("id"));
      if (!s || s.network !== n.net.caip2) return c.json({ error: "NOT_FOUND" }, 404);
      const refund = await getRefundBySession(db, s.id);
      return c.json({
        payment_session_id: s.id,
        payment_state: s.state,
        payment_txid: s.txid,
        explorer_url: n.net.explorerTx(s.txid),
        route: s.route,
        amount_atomic: s.amount,
        asset: s.asset,
        network: s.network,
        payer_class: s.payer_class,
        confirmed_round: s.confirmed_round,
        operation_id: s.operation_id,
        refund: refund ? summarize(refund) : null,
        updated_at: s.updated_at,
      });
    });
    if (prefix === "/v1") {
      // Trip ids are unguessable and trip documents carry no personal data, so a read by id is public.
      app.get("/v1/trips/:id", async (c) => {
        const trip = await store.getTrip(c.req.param("id"));
        if (!trip || trip.network !== n.net.name) return c.json({ error: "NOT_FOUND" }, 404);
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
    app.get(`${prefix}/stats/public`, async (c) => {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const all = await db
        .prepare(
          `SELECT COUNT(*) AS paid_calls, COALESCE(SUM(CAST(amount AS INTEGER)),0) AS atomic, COUNT(DISTINCT payer) AS payers
           FROM payment_sessions WHERE network = ?1 AND state IN ('SETTLED','CONFIRMED','RECONCILED')`,
        )
        .bind(n.net.caip2)
        .first<{ paid_calls: number; atomic: number; payers: number }>();
      const byClass = await db
        .prepare(
          `SELECT payer_class, COUNT(*) AS calls, COUNT(DISTINCT payer) AS payers, COALESCE(SUM(CAST(amount AS INTEGER)),0) AS atomic
           FROM payment_sessions WHERE network = ?1 AND state IN ('SETTLED','CONFIRMED','RECONCILED') GROUP BY payer_class`,
        )
        .bind(n.net.caip2)
        .all<{ payer_class: string; calls: number; payers: number; atomic: number }>();
      const repeat = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT payer FROM payment_sessions WHERE network = ?1 AND state IN ('SETTLED','CONFIRMED','RECONCILED') GROUP BY payer HAVING COUNT(*) >= 2)`,
        )
        .bind(n.net.caip2)
        .first<{ n: number }>();
      const recent = await db
        .prepare(`SELECT COUNT(*) AS n FROM payment_sessions WHERE network = ?1 AND state IN ('SETTLED','CONFIRMED','RECONCILED') AND created_at >= ?2`)
        .bind(n.net.caip2, since)
        .first<{ n: number }>();
      return c.json({
        environment: n.net.name.toUpperCase(),
        pay_to: n.payTo,
        paid_calls: all?.paid_calls ?? 0,
        usdc_settled: atomicToUsdc(String(all?.atomic ?? 0)),
        distinct_payers: all?.payers ?? 0,
        repeat_payers: repeat?.n ?? 0,
        paid_calls_24h: recent?.n ?? 0,
        by_payer_class: (byClass.results ?? []).map((r) => ({ payer_class: r.payer_class, paid_calls: r.calls, distinct_payers: r.payers, usdc: atomicToUsdc(String(r.atomic)) })),
        note: "Payer classes: EXTERNAL_ANON and EXTERNAL_ORG are payers the team does not control. INTERNAL_VALIDATION is team-controlled and is never counted as adoption.",
      });
    });
    app.post(`${prefix}/manifests/verify`, async (c) => {
      const keys = publishedKeys(deps.env);
      const body = (await c.req.json().catch(() => null)) as { manifest_id?: string; signed?: unknown } | null;
      let signed: unknown = body?.signed;
      if (!signed && body?.manifest_id) {
        const row = await store.getManifest(body.manifest_id);
        if (row) signed = JSON.parse(row.signed_json);
      }
      if (!signed || typeof signed !== "object") return c.json({ error: "INVALID_REQUEST", message: "Send {signed} or {manifest_id}." }, 422);
      const result = await verifyManifestDocument(signed as Signed<SignedRecord>, keys);
      if (!result.ok) {
        return c.json({ proof_state: integrityProofState(result), integrity: "INVALID", reason: result.reason, checked: ["payload_hash", "signature", "component_root", "decisions_root"], keys: keys.map((k) => k.key_id), note: VERIFY_NOTE });
      }
      const doc = signed as Signed<SignedRecord>;
      const recordId = "plan_id" in doc.payload ? doc.payload.plan_id : doc.payload.manifest_id;
      const anchorRow = await store.getAnchor(recordId);
      const anchor = anchorRow && anchorRow.network === n.net.name ? await checkAnchor(n.net, anchorRow.txid, doc.payload_hash) : ({ state: "ANCHOR_NOT_FOUND" } as const);
      const proof_state = anchor.state === "ANCHOR_CONFIRMED" ? "PROOF_VERIFIED" : anchor.state === "HASH_MISMATCH" ? "HASH_MISMATCH" : "PROOF_PARTIAL";
      return c.json({
        proof_state,
        integrity: "VALID",
        anchor: { ...anchor, network: n.net.caip2, ...("txid" in anchor ? { explorer: n.net.explorerTx(anchor.txid) } : {}) },
        checked: ["payload_hash", "signature", "component_root", "decisions_root", "anchor_note"],
        keys: keys.map((k) => k.key_id),
        note: VERIFY_NOTE,
      });
    });
    app.get(`${prefix}/manifests/:id`, async (c) => {
      const row = await store.getManifest(c.req.param("id"));
      if (!row || row.network !== n.net.name) return c.json({ error: "NOT_FOUND" }, 404);
      const anchor = await store.getAnchor(row.id);
      return c.json({
        manifest_id: row.id,
        kind: row.kind,
        status: row.status,
        hash: row.hash,
        expires_at: row.expires_at,
        anchor: anchor && anchor.network === n.net.name ? { mode: anchor.mode, network: n.net.caip2, state: anchor.state, txid: anchor.txid, confirmed_round: anchor.round, ...(anchor.txid ? { explorer: n.net.explorerTx(anchor.txid) } : {}) } : null,
        signed: JSON.parse(row.signed_json),
      });
    });
    app.get(`${prefix}/operations/:id`, async (c) => {
      const op = await getOperation(db, c.req.param("id"));
      if (!op || !op.route.startsWith(`POST ${prefix}/`)) return c.json({ error: "NOT_FOUND" }, 404);
      return c.json({
        operation_id: op.id,
        status: op.status,
        route: op.route,
        http_status: op.http_status,
        result: op.result_json ? JSON.parse(op.result_json) : null,
        trip_id: op.trip_id,
        updated_at: op.updated_at,
      });
    });
  }

  app.get("/.well-known/intyr-signing-keys.json", (c) =>
    c.json({
      keys: publishedKeys(deps.env),
      algorithm: "Ed25519",
      contexts: ["intyr/plan/v1", "intyr/manifest/v1", "intyr/transaction/v1", "intyr/status/v1"],
      anchor_accounts: anchorAccounts(deps.env),
      note: "Signed bytes are the context, a newline, then the RFC 8785 canonical JSON of the payload. An anchor note counts only when it was sent by the account listed for its network.",
    }),
  );
  app.get("/healthz", (c) => c.json({ ok: true, networks: nets.map((n) => n.net.name) }));
  app.get("/version", (c) => c.json({ ...deps.version, networks: nets.map((n) => ({ name: n.net.name, caip2: n.net.caip2, usdc_asset_id: n.net.usdcAssetId })) }));

  if (primary) {
    const routes = pricesPayload(primary).routes;
    app.get("/.well-known/x402", (c) => {
      const origin = new URL(c.req.url).origin;
      return c.json({
        x402Version: 2,
        tag: CHALLENGE_TAG,
        resources: ROUTE_PRICES.map((p, i) => ({
          url: origin + routes[i]!.path,
          method: "POST",
          description: p.description,
          network: primary.net.caip2,
          asset: primary.net.usdcAssetId,
          amount: p.amountAtomic,
          payTo: primary.payTo,
        })),
      });
    });

    const agentCard = (origin: string): Record<string, unknown> => ({
      name: "Intyr",
      description:
        "When an AI agent books a flight, a hotel and a transfer from different suppliers and one fails, Intyr stops or unwinds the rest inside limits set before paying, and leaves a receipt anyone can check.",
      url: origin,
      payment: { protocol: "x402", version: 2, network: primary.net.caip2, asset: primary.net.usdcAssetId, payTo: primary.payTo },
      capabilities: ROUTE_PRICES.map((p, i) => ({ name: p.name, method: "POST", path: routes[i]!.path, price_usdc: atomicToUsdc(p.amountAtomic) })),
      skills: ROUTE_PRICES.map((p) => ({ id: p.name, name: p.name, description: p.description })),
      docs: `${origin}/llms.txt`,
      openapi: `${origin}/openapi.json`,
      assurance: { mode: "NONE" },
    });
    app.get("/.well-known/agent.json", (c) => c.json(agentCard(new URL(c.req.url).origin)));
    app.get("/.well-known/agent-card.json", (c) => c.json(agentCard(new URL(c.req.url).origin)));

    app.get("/llms.txt", (c) => {
      const origin = new URL(c.req.url).origin;
      const lines = [
        "# Intyr",
        "",
        "> Payment-bound commit, recovery and verifiable receipts for AI agents that buy multi-supplier trips. Pay per action in USDC over x402 on Algorand.",
        "",
        "Every paid route answers 402 until a settled x402 payment accompanies the same request body. One payment produces one operation. Replaying the same payment proof returns the same operation.",
        "",
        "## Routes",
        ...ROUTE_PRICES.map((p, i) => `- POST ${origin}${routes[i]!.path} (${atomicToUsdc(p.amountAtomic)} USDC): ${p.description}`),
        "",
        "## Free",
        `- GET ${origin}/v1/prices`,
        `- GET ${origin}/v1/payments/{payment_session_id}`,
        `- GET ${origin}/v1/operations/{operation_id}`,
        `- GET ${origin}/.well-known/x402`,
        "",
        "## Rules an agent should follow",
        "- If a response has payment_state UNKNOWN or status PAYMENT_PENDING, do not pay again. Poll the poll_url.",
        "- If a response says the supplier outcome is UNKNOWN, do not retry the booking. Intyr reconciles before any retry.",
        "- Suppliers in this release are sandboxes, caller-supplied offers or seeded simulators. Each leg states its class and evidence grade.",
        "- Assurance mode is NONE. Intyr reduces the chance and size of partial bookings and underwrites nothing.",
        "",
      ];
      return c.text(lines.join("\n"));
    });

    app.get("/openapi.json", (c) => {
      const origin = new URL(c.req.url).origin;
      const paths: Record<string, unknown> = {};
      ROUTE_PRICES.forEach((p, i) => {
        paths[routes[i]!.path] = {
          post: {
            summary: p.name,
            description: p.description,
            "x-x402": { price_atomic: p.amountAtomic, asset: primary.net.usdcAssetId, network: primary.net.caip2, tag: CHALLENGE_TAG },
            requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
            responses: {
              "200": { description: "Payment settled and operation completed" },
              "202": { description: "Payment or operation pending. Do not pay again; poll poll_url." },
              "402": { description: "Payment required" },
              "409": { description: "PAYMENT_BINDING_MISMATCH: this payment was made for a different request" },
            },
          },
        };
      });
      return c.json({ openapi: "3.1.0", info: { title: "Intyr", version: "0.1.0" }, servers: [{ url: origin }], paths });
    });
  }

  app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}
