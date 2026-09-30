import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { CHALLENGE_TAG, routePrefix, type NetworkConfig } from "./config";
import { ROUTE_PRICES, atomicToUsdc } from "./prices";
import type { Ladder, PaidRoute } from "./payments/ladder";
import { getOperation, getSessionById } from "./payments/sessions";
import { notAvailable, type DomainHandlers, type RouteKey } from "./domain";
import { mountSandbox } from "./sandbox";
import { TripStore } from "./domain/store";

export interface NetworkDeps {
  net: NetworkConfig;
  payTo: string;
  ladder: Ladder;
}

export interface AppDeps {
  env: Env;
  /** Mainnet serves /v1 and is the only network registered in the Bazaar. TestNet serves /sandbox/v1. */
  mainnet?: NetworkDeps;
  testnet?: NetworkDeps;
  domain: DomainHandlers;
  version: { name: string; commit: string; contract_versions: Record<string, string> };
}

export function buildPaidRoutes(domain: DomainHandlers, prefix: string): PaidRoute[] {
  return ROUTE_PRICES.map((p) => {
    const d = domain[p.key as RouteKey];
    return {
      key: `POST ${prefix}${p.path.slice("/v1".length)}`,
      amountAtomic: p.amountAtomic,
      requireChainConfirmation: p.requires_chain_confirmation,
      precheck: d?.precheck ?? (d ? undefined : async () => notAvailable(p.key)),
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
  if (deps.testnet) mountSandbox(app, { db });
  const nets: NetworkDeps[] = [deps.mainnet, deps.testnet].filter((n): n is NetworkDeps => Boolean(n));

  for (const n of nets) {
    const prefix = routePrefix(n.net.name);
    for (const route of buildPaidRoutes(deps.domain, prefix)) {
      const path = route.key.split(" ")[1]!;
      app.post(path, (c) => n.ladder(c, route));
    }
    app.get(`${prefix}/prices`, (c) => c.json(pricesPayload(n)));
    app.get(`${prefix}/capabilities`, (c) =>
      c.json({
        product: "Intyr",
        environment: n.net.name.toUpperCase(),
        entry_type: "composite",
        assurance: { mode: "NONE" },
        leg_classes: ["CALLER_SUPPLIED", "SUPPLIER_SANDBOX", "SIMULATED", "X402_MERCHANT"],
        preparation_modes: ["HARD_HOLD", "SOFT_HOLD", "REVALIDATED", "INSTANT_COMMIT_ONLY", "UNSUPPORTED"],
        decision_outcomes: ["ACT", "NO_ACTION", "UNKNOWN", "REFUSE", "MANUAL_REVIEW"],
        routes: pricesPayload(n).routes,
        limits: ["Suppliers in this release are supplier sandboxes, caller-supplied offers or seeded simulators, and every leg says which."],
      }),
    );
    app.get(`${prefix}/payments/:id`, async (c) => {
      const s = await getSessionById(db, c.req.param("id"));
      if (!s || s.network !== n.net.caip2) return c.json({ error: "NOT_FOUND" }, 404);
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
        updated_at: s.updated_at,
      });
    });
    app.get(`${prefix}/manifests/:id`, async (c) => {
      const row = await store.getManifest(c.req.param("id"));
      if (!row || row.network !== n.net.name) return c.json({ error: "NOT_FOUND" }, 404);
      return c.json({ manifest_id: row.id, kind: row.kind, status: row.status, hash: row.hash, expires_at: row.expires_at, signed: JSON.parse(row.signed_json) });
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

    app.get("/.well-known/agent.json", (c) => {
      const origin = new URL(c.req.url).origin;
      return c.json({
        name: "Intyr",
        description:
          "When an AI agent books a flight, a hotel and a transfer from different suppliers and one fails, Intyr stops or unwinds the rest inside limits set before paying, and leaves a receipt anyone can check.",
        url: origin,
        payment: { protocol: "x402", version: 2, network: primary.net.caip2, asset: primary.net.usdcAssetId, payTo: primary.payTo },
        capabilities: ROUTE_PRICES.map((p, i) => ({ name: p.name, method: "POST", path: routes[i]!.path, price_usdc: atomicToUsdc(p.amountAtomic) })),
        docs: `${origin}/llms.txt`,
        openapi: `${origin}/openapi.json`,
        assurance: { mode: "NONE" },
      });
    });

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
