import { describe, expect, it } from "vitest";
import { normalizeList, normalizeTrip, type WireTrip } from "./trip-wire";

const clocks = {
  price_valid_until: "2026-09-30T20:26:13.911Z",
  inventory_held_until: null,
  free_cancel_until: "2026-10-02T19:56:13.911Z",
  void_until: null,
  refund_destination: "CASH" as const,
  refund_amount_certainty: "QUOTED" as const,
  confirmation_mode: "INSTANT" as const,
  supplier_can_cancel: false,
};

function component(id: string, type: string, state: string, amount: number, irreversible = false) {
  return {
    component_id: id,
    state,
    summary: { component_id: id, type, supplier: "intyr-simulator", leg_class: "SIMULATED", evidence_grade: "SIMULATED", preparation_mode: "REVALIDATED", irreversible, price: { amount_minor: amount, currency: "USD" } },
    leg: { component_id: id, type, adapter_id: "sim-ground", provider_id: "intyr-simulator", leg_class: "SIMULATED", evidence_grade: "SIMULATED", preparation_mode: "REVALIDATED", price: { amount_minor: amount, currency: "USD" }, clocks, irreversible, summary: `Simulated ${type.toLowerCase()}`, untrusted_notes: ["<b>not html</b>"] },
    refs: { booking_reference: state === "CONFIRMED" ? `REF-${id}` : null },
    outcome_verification: null,
    confirmation: state === "CONFIRMED" ? { evidence_tier: "E1", read_at: "2026-09-30T20:00:00Z", supplier_status: "confirmed", response_hash: null } : null,
    cancellation: null,
  };
}

const recovered: WireTrip = {
  trip_id: "trp_ceb6136ca5dac0094935c2d2",
  state: "RECOVERED",
  currency: "USD",
  budget_total_minor: 200000,
  trip_ref: "demo-rejected-flight",
  components: [component("hotel-1", "HOTEL", "CANCELLED", 18505), component("ground-2", "GROUND", "CANCELLED", 6123), component("flight-3", "FLIGHT", "COMMIT_FAILED", 29993, true)],
  commit_order: ["ground-2", "hotel-1", "flight-3"],
  next_actions: [{ action: "VERIFY", allowed: true, recommended_before: "2026-09-30T20:26:13.911Z" }],
  manifest_id: "man_initial",
  final_manifest_id: "man_final",
  manifest_hash: "sha256:" + "a".repeat(64),
  stranded_spend_minor: 0,
  financial_closure: "CLOSED",
  approval_required: false,
  anchor: null,
  decisions: [
    { decision_id: "dec_1", gate: "RECOVERY_ACTION", outcome: "ACT", reason_codes: ["CANCEL_WITHIN_FREE_WINDOW"], subject: { trip_id: "trp_ceb6136ca5dac0094935c2d2", component_id: "hotel-1" } },
  ],
};

describe("normalizeTrip", () => {
  const trip = normalizeTrip(recovered);

  it("orders legs by the server's commit order, irreversible last", () => {
    const byOrder = [...trip.components].sort((a, b) => (a.commit_order ?? 0) - (b.commit_order ?? 0)).map((c) => c.component_id);
    expect(byOrder).toEqual(["ground-2", "hotel-1", "flight-3"]);
    expect(trip.components.find((c) => c.component_id === "flight-3")?.irreversible).toBe(true);
  });

  it("separates the quoted total from what is still booked", () => {
    expect(trip.quoted_total).toEqual({ amount_minor: 18505 + 6123 + 29993, currency: "USD" });
    expect(trip.booked_total).toBeUndefined();
    expect(trip.stranded_spend).toEqual({ amount_minor: 0, currency: "USD" });
  });

  it("points the receipt at the final record and keeps the prepared one for commit", () => {
    expect(trip.manifest_id).toBe("man_final");
    expect(trip.initial_manifest_id).toBe("man_initial");
  });

  it("flattens supplier clocks onto each leg and keeps supplier text as data", () => {
    const hotel = trip.components.find((c) => c.component_id === "hotel-1");
    expect(hotel?.free_cancel_until).toBe("2026-10-02T19:56:13.911Z");
    expect(hotel?.untrusted_notes).toEqual(["<b>not html</b>"]);
    expect(hotel?.decisions?.map((d) => d.decision_id)).toEqual(["dec_1"]);
  });

  it("maps recommended_before to a deadline and always reports no assurance", () => {
    expect(trip.next_actions?.[0]).toEqual({ action: "VERIFY", allowed: true, deadline: "2026-09-30T20:26:13.911Z" });
    expect(trip.assurance?.mode).toBe("NONE");
  });

  it("uses the plan id as the record of a check-only trip", () => {
    const checked = normalizeTrip({ ...recovered, state: "CHECKED", manifest_id: null, final_manifest_id: null, plan_id: "man_plan" });
    expect(checked.manifest_id).toBe("man_plan");
  });

  it("returns an empty trip rather than throwing on an unexpected body", () => {
    expect(normalizeTrip({ trip_id: "trp_x", state: "PREPARING" })).toEqual({ trip_id: "trp_x", state: "PREPARING", components: [] });
  });
});

describe("normalizeList", () => {
  it("reads the items envelope and hides a missing next action", () => {
    const list = normalizeList({
      items: [{ trip_id: "trp_a", state: "COMMITTED", created_at: "2026-09-30T20:00:00Z", total: { amount_minor: 100, currency: "USD" }, components: [], next_action: null }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.next_action).toBeUndefined();
  });
});
