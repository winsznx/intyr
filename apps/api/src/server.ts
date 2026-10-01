import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { CHALLENGE_TAG, routePrefix, type NetworkConfig } from "./config";
import { ROUTE_PRICES } from "./prices";
import { requestSchemaOf } from "./request-schemas";

const EXAMPLE_HASH = `sha256:${"0".repeat(64)}`;

/**
 * Request bodies shown to Bazaar and discovery clients. Each one has to parse with its route's schema, because the
 * resource refresh sends the example first and a rejected example reads as a broken route.
 */
export const EXAMPLE_BODIES: Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }> = {
  "POST /v1/trips/check": {
    input: {
      currency: "USD",
      legs: [
        {
          leg_id: "hotel-1",
          type: "HOTEL",
          supplier: "example-hotels",
          offer_ref: "offer-hotel-001",
          price: { amount_minor: 41000, currency: "USD" },
          preparation_mode: "REVALIDATED",
          refundable: true,
          clocks: { price_valid_until: "2027-06-30T12:00:00Z", free_cancel_until: "2027-09-01T12:00:00Z", refund_destination: "CASH", refund_amount_certainty: "QUOTED", supplier_can_cancel: true },
        },
        {
          leg_id: "flight-1",
          type: "FLIGHT",
          supplier: "example-airline",
          offer_ref: "offer-flight-001",
          price: { amount_minor: 52000, currency: "USD" },
          preparation_mode: "HARD_HOLD",
          refundable: true,
          clocks: { price_valid_until: "2027-06-30T12:30:00Z", inventory_held_until: "2027-07-01T12:30:00Z", void_until: "2027-07-02T12:30:00Z", refund_destination: "CASH" },
          depends_on: ["hotel-1"],
        },
      ],
      limits: { max_total_minor: 100000 },
    },
    output: { plan_id: "pln_example", verdict: "COMMIT_NOW", commit_order: ["hotel-1", "flight-1"], payment_state: "SETTLED" },
  },
  "POST /v1/trips/prepare": {
    input: {
      currency: "EUR",
      budget_total_minor: 150000,
      components: [
        { type: "FLIGHT", origin: "JFK", destination: "LHR", depart_date: "2027-09-10", passengers: 1 },
        { type: "HOTEL", city: "London", check_in: "2027-09-10", check_out: "2027-09-12", guests: 1 },
      ],
    },
    output: { trip_id: "trp_0123456789abcdef01234567", state: "PREPARED", manifest_id: "man_example" },
  },
  "POST /v1/trips/revalidate": {
    input: { trip_id: "trp_0123456789abcdef01234567" },
    output: { trip_id: "trp_0123456789abcdef01234567", state: "PREPARED", manifest_changed: false },
  },
  "POST /v1/trips/commit": {
    input: { trip_id: "trp_0123456789abcdef01234567", manifest_id: "man_example", manifest_hash: EXAMPLE_HASH, maximum_total_minor: 100000, currency: "USD", recovery_policy_acknowledged: true },
    output: { trip_id: "trp_0123456789abcdef01234567", state: "COMMITTED" },
  },
  "POST /v1/trips/recover": {
    input: { trip_id: "trp_0123456789abcdef01234567", allow_replacement: false, replacement_headroom_minor: 0 },
    output: { trip_id: "trp_0123456789abcdef01234567", state: "RECOVERED" },
  },
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
        inputSchema: requestSchemaOf(p.key),
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
