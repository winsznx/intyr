import { describe, expect, it } from "vitest";
import { CheckRequestSchema, jsonSchemaOf, parseWith, PublicTripIntentSchema } from "../src/schema";
import { wireLeg } from "./fixtures";

describe("CheckRequestSchema", () => {
  it("fills unknown clocks with null and applies leg defaults", () => {
    // #given a leg with no clocks, dependencies or required flag
    const parsed = CheckRequestSchema.parse({ currency: "USD", legs: [wireLeg("hotel", { clocks: undefined })] });

    // #then every clock is explicitly null and the leg is required with no dependencies
    expect(parsed.legs[0]).toMatchObject({
      clocks: {
        price_valid_until: null,
        inventory_held_until: null,
        free_cancel_until: null,
        void_until: null,
        refund_destination: "UNKNOWN",
        refund_amount_certainty: "UNKNOWN",
        confirmation_mode: "INSTANT",
        supplier_can_cancel: false,
      },
      depends_on: [],
      required: true,
    });
  });

  it("defaults limits to none", () => {
    expect(CheckRequestSchema.parse({ currency: "USD", legs: [wireLeg("hotel")] }).limits).toEqual({});
  });

  it("reports the failing field path instead of throwing", () => {
    const result = parseWith(CheckRequestSchema, {
      currency: "USD",
      legs: [wireLeg("hotel", { price: { amount_minor: 10.5, currency: "USD" } })],
    });
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual(["legs.0.price.amount_minor"]);
  });

  it("rejects a currency that is not an upper-case ISO code", () => {
    expect(parseWith(CheckRequestSchema, { currency: "usd", legs: [wireLeg("hotel")] }).ok).toBe(false);
  });

  it("rejects an empty leg list", () => {
    expect(parseWith(CheckRequestSchema, { currency: "USD", legs: [] }).ok).toBe(false);
  });
});

describe("PublicTripIntentSchema", () => {
  const intent = {
    currency: "USD",
    budget_total_minor: 150_000,
    components: [
      { type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-02" },
      { type: "HOTEL", city: "New York", check_in: "2026-11-02", check_out: "2026-11-05" },
    ],
  };

  it("accepts a flight and hotel intent without any organization or traveler data", () => {
    expect(parseWith(PublicTripIntentSchema, intent).ok).toBe(true);
  });

  it("accepts a sandbox scenario that names a simulator scenario per component", () => {
    const withScenario = { ...intent, scenario: { seed: 7, faults: [{ component_index: 1, fault: "TIMEOUT_BOOKED" }] } };
    expect(parseWith(PublicTripIntentSchema, withScenario).ok).toBe(true);
  });

  it("rejects a component type it does not know", () => {
    expect(parseWith(PublicTripIntentSchema, { ...intent, components: [{ type: "CRUISE" }] }).ok).toBe(false);
  });
});

describe("jsonSchemaOf", () => {
  it("emits an object schema that requires currency and legs for discovery", () => {
    const schema = jsonSchemaOf(CheckRequestSchema);
    expect([schema.type, schema.required]).toEqual(["object", ["currency", "legs"]]);
  });
});
