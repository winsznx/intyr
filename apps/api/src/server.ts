import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { CHALLENGE_TAG, routePrefix, type NetworkConfig } from "./config";
import { ROUTE_PRICES } from "./prices";

const EXAMPLE_BODIES: Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }> = {
  "POST /v1/trips/check": {
    input: {
      legs: [
        {
          leg_id: "hotel-1",
          type: "HOTEL",
          supplier: "example-hotels",
          price: { amount_minor: 41000, currency: "USD" },
          refundable: true,
          free_cancel_until: "2026-11-01T12:00:00Z",
          price_valid_until: "2026-10-05T12:00:00Z",
        },
        {
          leg_id: "flight-1",
          type: "FLIGHT",
          supplier: "example-airline",
          price: { amount_minor: 52000, currency: "USD" },
          refundable: false,
          price_valid_until: "2026-10-05T12:30:00Z",
          requires_instant_payment: true,
        },
      ],
      budget: { total_minor: 100000, currency: "USD" },
      max_price_movement_pct: 2,
    },
    output: { plan_id: "man_example", verdict: "COMMIT_NOW", commit_order: ["hotel-1", "flight-1"], payment_state: "CONFIRMED" },
  },
  "POST /v1/trips/prepare": {
    input: { legs: [{ type: "FLIGHT", origin: "JFK", destination: "EWR", date: "2026-11-01", adults: 1 }], budget: { total_minor: 100000, currency: "USD" } },
    output: { trip_id: "trp_example", state: "PREPARED", manifest_id: "man_example" },
  },
  "POST /v1/trips/revalidate": { input: { trip_id: "trp_example" }, output: { trip_id: "trp_example", state: "READY_TO_COMMIT", manifest_changed: false } },
  "POST /v1/trips/commit": { input: { trip_id: "trp_example", manifest_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }, output: { trip_id: "trp_example", state: "COMMITTED" } },
  "POST /v1/trips/recover": { input: { trip_id: "trp_example" }, output: { trip_id: "trp_example", state: "RECOVERED" } },
};

export function buildRoutes(net: NetworkConfig, payTo: string): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const p of ROUTE_PRICES) {
    const ex = EXAMPLE_BODIES[p.key]!;
    const prefix = routePrefix(net.name);
    routes[`POST ${prefix}${p.path.slice("/v1".length)}`] = {
      accepts: [
        {
          scheme: "exact",
          network: net.caip2 as `${string}:${string}`,
          price: { amount: p.amountAtomic, asset: net.usdcAssetId },
          payTo,
          maxTimeoutSeconds: 300,
          extra: { tag: CHALLENGE_TAG },
        },
      ],
      description: p.description,
      mimeType: "application/json",
      serviceName: "Intyr",
      tags: [CHALLENGE_TAG, "travel", "booking", "agents", "commit", "recovery"],
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: ex.input,
        output: { example: ex.output },
      }),
    } as RouteConfig;
  }
  return routes;
}

export interface X402Server {
  httpServer: x402HTTPResourceServer;
  resourceServer: x402ResourceServer;
}

export function createX402Server(net: NetworkConfig, payTo: string, facilitator: FacilitatorClient | string): X402Server {
  const client = typeof facilitator === "string" ? new HTTPFacilitatorClient({ url: facilitator }) : facilitator;
  const resourceServer = new x402ResourceServer(client).register(net.caip2 as `${string}:${string}`, new ExactAvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension as never);
  const httpServer = new x402HTTPResourceServer(resourceServer, buildRoutes(net, payTo));
  return { httpServer, resourceServer };
}
