import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { CHALLENGE_TAG, type NetworkConfig } from "./config";
import { ROUTE_PRICES, atomicToUsdc } from "./prices";
import type { Ladder, PaidRoute } from "./payments/ladder";
import { getOperation, getSessionById } from "./payments/sessions";
import { notAvailable, type DomainHandlers, type RouteKey } from "./domain";

export interface AppDeps {
  env: Env;
  net: NetworkConfig;
  ladder: Ladder;
  domain: DomainHandlers;
  version: { name: string; commit: string; contract_versions: Record<string, string> };
}

export function buildPaidRoutes(domain: DomainHandlers): PaidRoute[] {
  return ROUTE_PRICES.map((p) => {
    const d = domain[p.key as RouteKey];
    return {
      key: p.key,
      amountAtomic: p.amountAtomic,
      requireChainConfirmation: p.requires_chain_confirmation,
      precheck: d?.precheck ?? (d ? undefined : async () => notAvailable(p.key)),
      handler: d?.handler ?? (async () => notAvailable(p.key)),
    };
  });
}

function pricesPayload(deps: AppDeps) {
  return {
    network: deps.net.caip2,
    asset: deps.net.usdcAssetId,
    pay_to: deps.env.PAY_TO,
    tag: CHALLENGE_TAG,
    note: "Exact-amount x402 payments in USDC. Prices are initial assumptions and are reviewed against measured usage.",
    routes: ROUTE_PRICES.map((p) => ({
      method: "POST",
      path: p.path,
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
  const paid = buildPaidRoutes(deps.domain);

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["content-type", "payment-signature", "x-payment", "idempotency-key"],
      exposeHeaders: ["payment-required", "payment-response", "x-payment-response", "intyr-replay"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  for (const route of paid) {
    const path = route.key.split(" ")[1]!;
    app.post(path, (c) => deps.ladder(c, route));
  }

  app.get("/healthz", (c) => c.json({ ok: true, network: deps.net.name }));
  app.get("/version", (c) => c.json({ ...deps.version, network: deps.net.caip2, usdc_asset_id: deps.net.usdcAssetId }));
  app.get("/v1/prices", (c) => c.json(pricesPayload(deps)));
  app.get("/v1/capabilities", (c) =>
    c.json({
      product: "Intyr",
      entry_type: "composite",
      assurance: { mode: "NONE" },
      leg_classes: ["CALLER_SUPPLIED", "SUPPLIER_SANDBOX", "SIMULATED", "X402_MERCHANT"],
      preparation_modes: ["HARD_HOLD", "SOFT_HOLD", "REVALIDATED", "INSTANT_COMMIT_ONLY", "UNSUPPORTED"],
      decision_outcomes: ["ACT", "NO_ACTION", "UNKNOWN", "REFUSE", "MANUAL_REVIEW"],
      routes: pricesPayload(deps).routes,
      limits: ["Suppliers in this release are supplier sandboxes, caller-supplied offers or seeded simulators, and every leg says which."],
    }),
  );

  app.get("/v1/payments/:id", async (c) => {
    const s = await getSessionById(deps.env.DB, c.req.param("id"));
    if (!s) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({
      payment_session_id: s.id,
      payment_state: s.state,
      payment_txid: s.txid,
      explorer_url: deps.net.explorerTx(s.txid),
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

  app.get("/v1/operations/:id", async (c) => {
    const op = await getOperation(deps.env.DB, c.req.param("id"));
    if (!op) return c.json({ error: "NOT_FOUND" }, 404);
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

  app.get("/.well-known/x402", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      x402Version: 2,
      tag: CHALLENGE_TAG,
      resources: ROUTE_PRICES.map((p) => ({
        url: origin + p.path,
        method: "POST",
        description: p.description,
        network: deps.net.caip2,
        asset: deps.net.usdcAssetId,
        amount: p.amountAtomic,
        payTo: deps.env.PAY_TO,
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
      payment: { protocol: "x402", version: 2, network: deps.net.caip2, asset: deps.net.usdcAssetId, payTo: deps.env.PAY_TO },
      capabilities: ROUTE_PRICES.map((p) => ({ name: p.name, method: "POST", path: p.path, price_usdc: atomicToUsdc(p.amountAtomic) })),
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
      ...ROUTE_PRICES.map((p) => `- POST ${origin}${p.path} (${atomicToUsdc(p.amountAtomic)} USDC): ${p.description}`),
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
    for (const p of ROUTE_PRICES) {
      paths[p.path] = {
        post: {
          summary: p.name,
          description: p.description,
          "x-x402": { price_atomic: p.amountAtomic, asset: deps.net.usdcAssetId, network: deps.net.caip2, tag: CHALLENGE_TAG },
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "Payment settled and operation completed" },
            "202": { description: "Payment or operation pending. Do not pay again; poll poll_url." },
            "402": { description: "Payment required" },
            "409": { description: "PAYMENT_BINDING_MISMATCH: this payment was made for a different request" },
          },
        },
      };
    }
    return c.json({ openapi: "3.1.0", info: { title: "Intyr", version: "0.1.0" }, servers: [{ url: origin }], paths });
  });

  app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}
