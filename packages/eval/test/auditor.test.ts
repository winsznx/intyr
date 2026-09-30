import { describe, expect, it } from "vitest";

import type { SimOrder } from "@intyr/adapters";

import { auditTrip, CELLS, runB0, runInProcess, SHAPES, signTest, tripFor, type ArmReport, type TripSpec } from "../src";

const trip: TripSpec = {
  trip_id: "trp_t",
  seed: "s",
  max_total_minor: 100_000,
  currency: "USD",
  components: [
    { component_id: "f", type: "FLIGHT", adults: 1, currency: "USD" },
    { component_id: "h", type: "HOTEL", adults: 1, currency: "USD" },
  ],
};

function order(component_id: string, status: SimOrder["status"], amount = 10_000): SimOrder {
  return {
    booking_id: `bk_${component_id}_${Math.random()}`,
    booking_reference: "REF",
    component_id,
    offer_id: "o",
    idempotency_ref: "i",
    operation_id: "op",
    status,
    settles_to: null,
    settles_at: null,
    price: { amount_minor: amount, currency: "USD" },
    created_at: "",
    visible_at: "",
    cancelled_at: null,
    refund: null,
  };
}

const report = (beliefs: Record<string, "BOOKED" | "NOT_BOOKED" | "UNKNOWN">): ArmReport => ({
  arm: "X",
  trip_id: "trp_t",
  verdict: "PARTIAL",
  components: Object.entries(beliefs).map(([component_id, belief]) => ({ component_id, belief, booking_ids: [] })),
  notes: [],
});

describe("auditor", () => {
  it("classifies complete, unwound, orphan and duplicate trips from supplier orders only", () => {
    expect(auditTrip(trip, [order("f", "CONFIRMED"), order("h", "CONFIRMED")], report({ f: "BOOKED", h: "BOOKED" })).outcome).toBe("COMPLETE");
    expect(auditTrip(trip, [order("f", "CANCELLED")], report({ f: "NOT_BOOKED", h: "NOT_BOOKED" })).outcome).toBe("UNWOUND");
    const orphan = auditTrip(trip, [order("f", "CONFIRMED", 24_000)], report({ f: "BOOKED", h: "NOT_BOOKED" }));
    expect([orphan.outcome, orphan.inconsistency, orphan.orphan_value_minor]).toEqual(["INCONSISTENT", "ORPHAN", 24_000]);
    const dup = auditTrip(trip, [order("f", "CONFIRMED"), order("f", "CONFIRMED"), order("h", "CONFIRMED")], report({ f: "BOOKED", h: "BOOKED" }));
    expect([dup.outcome, dup.inconsistency, dup.duplicate_orders]).toEqual(["INCONSISTENT", "DUPLICATE", 1]);
  });

  it("counts a belief that contradicts the supplier as a mismatch and an honest UNKNOWN separately", () => {
    const res = auditTrip(trip, [order("f", "CONFIRMED")], report({ f: "NOT_BOOKED", h: "UNKNOWN" }));
    expect(res.belief_mismatches).toBe(1);
    expect(res.belief_unknowns).toBe(1);
  });

  it("sign test matches the pre-registered threshold arithmetic", () => {
    expect(signTest(6, 0)).toBeCloseTo(0.03125, 5);
    expect(signTest(5, 1)).toBeGreaterThan(0.05);
  });
});

describe("naive arm against the simulator", () => {
  const cell = (id: string) => CELLS.find((c) => c.id === id)!;
  const run = (id: string) => runInProcess(runB0, tripFor(cell(id), SHAPES[0]!, 1, "test"), { campaign: "test", cell: id, shape: "S1", repeat: 1, armName: "B0" });

  it("completes the healthy control", async () => {
    const r = await run("C0");
    expect(r.audit.outcome).toBe("COMPLETE");
    expect(r.audit.belief_mismatches).toBe(0);
  });

  it("strands the flight when the hotel refuses (orphan)", async () => {
    const r = await run("F3");
    expect(r.audit.outcome).toBe("INCONSISTENT");
    expect(r.audit.inconsistency).toBe("ORPHAN");
    expect(r.audit.orphan_value_minor).toBeGreaterThan(0);
  });

  it("double-books when it blindly retries a lost response", async () => {
    const r = await run("F8");
    expect(r.audit.duplicate_orders).toBe(1);
  });

  it("believes a booking that does not exist when the response lies", async () => {
    const r = await run("F7");
    expect(r.audit.belief_mismatches).toBeGreaterThan(0);
  });
});
