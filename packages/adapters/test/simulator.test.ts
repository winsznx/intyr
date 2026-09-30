import { describe, expect, it } from "vitest";

import { MemorySimulatorStore, SimulatorAdapter, type ComponentRequest, type PreparedLeg, type SimScenario } from "../src";

class TestClock {
  constructor(public t = Date.parse("2026-10-01T12:00:00Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

function setup(lag = 5) {
  const clock = new TestClock();
  const store = new MemorySimulatorStore();
  const sim = new SimulatorAdapter({ adapterId: "sim-hostile", store, clock, visibilityLagSeconds: lag });
  return { clock, store, sim };
}

function request(scenario: SimScenario, extra: Partial<ComponentRequest> = {}): ComponentRequest {
  return { component_id: "cmp_1", type: "FLIGHT", origin: "LHR", destination: "JFK", depart_date: "2026-11-01", adults: 1, currency: "USD", sim: { scenario, seed: `seed-${scenario}` }, ...extra };
}

async function prepared(sim: SimulatorAdapter, scenario: SimScenario, extra: Partial<ComponentRequest> = {}): Promise<PreparedLeg> {
  const res = await sim.prepare(request(scenario, extra));
  if (!res.ok) throw new Error(res.detail);
  return res.leg;
}

function commitReq(leg: PreparedLeg, ref = "idem_1") {
  return {
    leg,
    operation_id: "ops_1",
    idempotency_ref: ref,
    max_total: { ...leg.price, amount_minor: leg.price.amount_minor * 2 },
    traveler: { given_name: "Ada", family_name: "Lovelace", born_on: "1990-12-10", email: "a@b.c", phone_number: "+1", gender: "f" as const, title: "ms" as const },
  };
}

describe("simulator adapter", () => {
  it("is deterministic for the same seed and labels itself simulated", async () => {
    const a = setup();
    const b = setup();
    const legA = await prepared(a.sim, "HAPPY");
    const legB = await prepared(b.sim, "HAPPY");
    expect(legA.price).toEqual(legB.price);
    expect(legA.refs.offer_id).toEqual(legB.refs.offer_id);
    expect(legA.leg_class).toBe("SIMULATED");
    expect(legA.evidence_grade).toBe("SIMULATED");
  });

  it("confirms a happy commit only through the independent read", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "HAPPY");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("RESPONDED_CONFIRMED");
    const read = await sim.postcondition(leg, res.refs);
    expect(read.found).toBe("PRESENT");
    expect(read.confirmed).toBe(true);
  });

  it("reprices once on PRICE_DIVERGENCE", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "PRICE_DIVERGENCE");
    const first = await sim.revalidate(leg);
    expect(first.status).toBe("PRICE_CHANGED");
    expect(first.leg.price.amount_minor).toBe(Math.round(leg.price.amount_minor * 1.08));
    const second = await sim.revalidate(first.leg);
    expect(second.status).toBe("UNCHANGED");
  });

  it("rejects a stale-price commit on PRICE_DIVERGENCE and reports the new price on the next read", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "PRICE_DIVERGENCE");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("REJECTED");
    expect(res.error_code).toBe("price_changed");
    const after = await sim.revalidate(leg);
    expect(after.status).toBe("PRICE_CHANGED");
    expect(after.leg.price.amount_minor).toBe(Math.round(leg.price.amount_minor * 1.08));
  });

  it("rejects definitely when inventory is gone at commit", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "UNAVAILABLE_AT_COMMIT");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("REJECTED");
    expect(res.no_booking_certain).toBe(true);
    expect(await sim.auditOrders(leg.sim!.seed)).toHaveLength(0);
  });

  it("TIMEOUT_BOOKED: unknown response, invisible during the lag, present after it", async () => {
    const { sim, clock } = setup(5);
    const leg = await prepared(sim, "TIMEOUT_BOOKED");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("UNKNOWN");
    expect((await sim.reconcileByReference(leg, "idem_1")).found).toBe("UNKNOWN");
    clock.advance(6);
    const later = await sim.reconcileByReference(leg, "idem_1");
    expect(later.found).toBe("PRESENT");
    expect(later.confirmed).toBe(true);
  });

  it("TIMEOUT_NOT_BOOKED: absence becomes final only after the visibility lag", async () => {
    const { sim, clock } = setup(5);
    const leg = await prepared(sim, "TIMEOUT_NOT_BOOKED");
    await sim.commit(commitReq(leg));
    const early = await sim.reconcileByReference(leg, "idem_1");
    expect(early.found).toBe("UNKNOWN");
    expect(early.absent_is_final).toBe(false);
    clock.advance(6);
    const late = await sim.reconcileByReference(leg, "idem_1");
    expect(late.found).toBe("ABSENT");
    expect(late.absent_is_final).toBe(true);
  });

  it("has no commit idempotency: a blind retry creates a duplicate order", async () => {
    const { sim } = setup(0);
    const leg = await prepared(sim, "DUPLICATE_ON_RETRY");
    await sim.commit(commitReq(leg));
    await sim.commit(commitReq(leg));
    expect(await sim.auditOrders(leg.sim!.seed)).toHaveLength(2);
    const read = await sim.reconcileByReference(leg, "idem_1");
    expect(read.found).toBe("PRESENT");
    expect(read.detail).toContain("duplicate");
  });

  it("async acceptance settles to confirmed or failed after the lag", async () => {
    for (const [scenario, expected] of [["ACCEPTED_ASYNC_CONFIRMS", "PRESENT"], ["ACCEPTED_ASYNC_FAILS", "ABSENT"]] as const) {
      const { sim, clock } = setup(3);
      const leg = await prepared(sim, scenario);
      const res = await sim.commit(commitReq(leg));
      expect(res.response).toBe("RESPONDED_ACCEPTED");
      const pending = await sim.postcondition(leg, res.refs);
      expect(pending.confirmed).toBe(false);
      clock.advance(4);
      const settled = await sim.postcondition(leg, res.refs);
      expect(settled.found).toBe(expected);
      expect(settled.confirmed).toBe(expected === "PRESENT");
    }
  });

  it("RESPONSE_OK_STATUS_DISAGREES: the response claims a booking that the read never finds", async () => {
    const { sim, clock } = setup(2);
    const leg = await prepared(sim, "RESPONSE_OK_STATUS_DISAGREES");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("RESPONDED_CONFIRMED");
    clock.advance(3);
    const read = await sim.postcondition(leg, res.refs);
    expect(read.found).toBe("ABSENT");
    expect(read.absent_is_final).toBe(true);
  });

  it("refuses cancellation on CANCEL_REFUSED and charges fully on NON_REFUNDABLE", async () => {
    const refused = setup();
    const legR = await prepared(refused.sim, "CANCEL_REFUSED");
    const resR = await refused.sim.commit(commitReq(legR));
    expect((await refused.sim.cancel(legR, resR.refs)).outcome).toBe("REFUSED");

    const nonref = setup();
    const legN = await prepared(nonref.sim, "NON_REFUNDABLE");
    expect(legN.irreversible).toBe(true);
    expect(legN.clocks.refund_destination).toBe("NONE");
    const resN = await nonref.sim.commit(commitReq(legN));
    const cancel = await nonref.sim.cancel(legN, resN.refs);
    expect(cancel.outcome).toBe("CANCELLED_WITH_CHARGES");
    expect(cancel.refund?.amount_minor).toBe(0);
  });

  it("rejects payment on an expired hold", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "HOLD_EXPIRY", { hold: true });
    expect(leg.preparation_mode).toBe("HARD_HOLD");
    const res = await sim.commit(commitReq(leg));
    expect(res.response).toBe("REJECTED");
    expect(res.error_code).toBe("hold_expired");
  });

  it("refuses a commit above the committed maximum", async () => {
    const { sim } = setup();
    const leg = await prepared(sim, "HAPPY");
    const res = await sim.commit({ ...commitReq(leg), max_total: { ...leg.price, amount_minor: leg.price.amount_minor - 1 } });
    expect(res.response).toBe("REJECTED");
    expect(res.no_booking_certain).toBe(true);
  });

  it("returns OVER_BUDGET when the cap is below every price", async () => {
    const { sim } = setup();
    const res = await sim.prepare(request("HAPPY", { max_price_minor: 1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("OVER_BUDGET");
  });
});
