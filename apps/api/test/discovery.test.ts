import { describe, expect, it } from "vitest";
import { CheckRequestSchema, CommitRequestSchema, PublicTripIntentSchema, RecoverRequestSchema, RevalidateRequestSchema, generateSigningKey, parseWith } from "@intyr/core";
import type { ZodType } from "zod";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { networkConfig } from "../src/config";
import { createDomain } from "../src/domain/wire";
import { EXAMPLE_BODIES } from "../src/server";
import { createTestD1 } from "./support/d1";

const SCHEMAS: Record<string, ZodType> = {
  "POST /v1/trips/check": CheckRequestSchema,
  "POST /v1/trips/prepare": PublicTripIntentSchema,
  "POST /v1/trips/revalidate": RevalidateRequestSchema,
  "POST /v1/trips/commit": CommitRequestSchema,
  "POST /v1/trips/recover": RecoverRequestSchema,
};

async function domainEnv(): Promise<Env> {
  const pair = await generateSigningKey("k");
  return { DB: createTestD1(), FACILITATOR_URL: "x", PAY_TO_TESTNET: "PAYTO", MANIFEST_SIGNING_JWK: JSON.stringify(pair.privateJwk) } as unknown as Env;
}

describe("discovery examples", () => {
  it("parses the example body of every paid route with that route's own schema", () => {
    expect(Object.keys(EXAMPLE_BODIES).sort()).toEqual(Object.keys(SCHEMAS).sort());
    for (const [route, schema] of Object.entries(SCHEMAS)) {
      const parsed = parseWith(schema, EXAMPLE_BODIES[route]!.input);
      expect(parsed.ok, `${route}: ${parsed.ok ? "" : JSON.stringify(parsed.issues)}`).toBe(true);
    }
  });
});

describe("prepare precheck", () => {
  it("refuses a component type that has no adapter before any charge", async () => {
    const env = await domainEnv();
    const domain = createDomain(env, "TESTNET");
    const intent = { currency: "USD", budget_total_minor: 50000, components: [{ type: "FLIGHT", origin: "JFK", destination: "EWR", depart_date: "2026-11-10", passengers: 1 }, { type: "ESIM", merchant_id: "m1", max_price_minor: 1000 }] };
    const refused = await domain.handlers["POST /v1/trips/prepare"]!.precheck!(intent, {});
    expect(refused).toMatchObject({ status: 422, body: { error: "UNSUPPORTED_COMPONENT", charged: false, issues: [{ path: "components.1.type" }] } });
    const ok = await domain.handlers["POST /v1/trips/prepare"]!.precheck!({ ...intent, components: [intent.components[0]] }, {});
    expect(ok).toBeNull();
  });
});

describe("verify", () => {
  it("accepts a signed plan from check and finds its anchor by plan id", async () => {
    const env = await domainEnv();
    const domain = createDomain(env, "TESTNET");
    const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net: networkConfig("testnet"), payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: domain.handlers } });
    const session = await app.request("https://x.test/sandbox/session", { method: "POST" });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const check = await app.request("https://x.test/sandbox/v1/trips/check", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(EXAMPLE_BODIES["POST /v1/trips/check"]!.input) });
    expect(check.status).toBe(200);
    const body = (await check.json()) as { plan?: { signed?: unknown }; signed?: unknown };
    const signed = body.signed ?? body.plan?.signed ?? body.plan;
    expect(signed).toBeTruthy();
    const verified = (await (await app.request("https://x.test/sandbox/v1/manifests/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed }) })).json()) as { integrity: string; proof_state: string };
    expect(verified).toMatchObject({ integrity: "VALID", proof_state: "PROOF_PARTIAL" });
  });
});

describe("openapi", () => {
  it("publishes each paid route's request schema instead of a bare object", async () => {
    const env = await domainEnv();
    const domain = createDomain(env, "TESTNET");
    const app = createApp({ env, version: { name: "t", commit: "t", contract_versions: {} }, testnet: { net: networkConfig("testnet"), payTo: "PAYTO", ladder: (() => new Response("no")) as never, domain: domain.handlers } });
    const doc = (await (await app.request("https://x.test/openapi.json")).json()) as { paths: Record<string, { post: { requestBody: { content: { "application/json": { schema: { type?: string; required?: string[]; properties?: Record<string, unknown> } } } } } }> };
    const schemaOf = (path: string) => doc.paths[path]!.post.requestBody.content["application/json"].schema;
    expect(Object.keys(schemaOf("/sandbox/v1/trips/check").properties ?? {})).toEqual(expect.arrayContaining(["currency", "legs"]));
    expect(schemaOf("/sandbox/v1/trips/commit").required).toEqual(expect.arrayContaining(["trip_id", "manifest_id", "manifest_hash", "recovery_policy_acknowledged"]));
    expect(schemaOf("/sandbox/v1/trips/prepare").required).toEqual(expect.arrayContaining(["components", "budget_total_minor"]));
    expect(JSON.stringify(doc)).not.toContain("json-schema.org/draft");
  });

  it("links TestNet transactions to an explorer that resolves", () => {
    expect(networkConfig("testnet").explorerTx("TX1")).toBe("https://lora.algokit.io/testnet/transaction/TX1");
    expect(networkConfig("mainnet").explorerTx("TX1")).toBe("https://allo.info/tx/TX1");
  });
});
