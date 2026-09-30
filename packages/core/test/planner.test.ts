import { describe, expect, it } from "vitest";
import {
  assessLegs,
  checkTrip,
  decidePrepare,
  legFromCaller,
  legFromPrepared,
  planTrip,
  type PreparedLegInput,
} from "../src/planner";
import { PUBLIC_DEFAULT_POLICY } from "../src/policy";
import { generateSigningKey, publishedKey, verifyDocument } from "../src/sign";
import { checkRequest, inMinutes, irreversibleWireLeg, NOW, TRIP_ID, wireLeg } from "./fixtures";

const ctx = { now: NOW, environment: "TESTNET" as const };

describe("planTrip commit order", () => {
  it("commits reversible legs before irreversible ones", async () => {
    // #given an irreversible flight listed before a refundable hotel
    const request = checkRequest([irreversibleWireLeg("flight"), wireLeg("hotel")]);

    // #when the plan is computed
    const plan = await planTrip(request, ctx);

    // #then the hotel, which can be undone, goes first
    expect(plan.commit_order).toEqual(["hotel", "flight"]);
  });

  it("commits a dependency before the leg that depends on it", async () => {
    // #given a refundable transfer that depends on an irreversible flight
    const request = checkRequest([
      wireLeg("transfer", { type: "GROUND", depends_on: ["flight"] }),
      irreversibleWireLeg("flight"),
      wireLeg("hotel"),
    ]);

    const plan = await planTrip(request, ctx);

    // #then dependency depth outranks reversibility
    expect(plan.commit_order).toEqual(["hotel", "flight", "transfer"]);
  });

  it("commits the leg whose price expires first when reversibility ties", async () => {
    const request = checkRequest([
      wireLeg("late", { clocks: { price_valid_until: inMinutes(50), free_cancel_until: inMinutes(600) } }),
      wireLeg("early", { clocks: { price_valid_until: inMinutes(40), free_cancel_until: inMinutes(600) } }),
    ]);

    const plan = await planTrip(request, ctx);

    expect(plan.commit_order).toEqual(["early", "late"]);
  });

  it("produces the same order regardless of input order", async () => {
    const legs = [irreversibleWireLeg("flight"), wireLeg("hotel"), wireLeg("transfer", { type: "GROUND" })];
    const forward = await planTrip(checkRequest(legs), ctx);
    const reversed = await planTrip(checkRequest([...legs].reverse()), ctx);
    expect(forward.commit_order).toEqual(reversed.commit_order);
  });
});

describe("planTrip verdicts", () => {
  it("says COMMIT_NOW when every check passes", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel"), irreversibleWireLeg("flight")]), ctx);
    expect([plan.verdict, plan.decision.outcome, plan.decision.reason_codes]).toEqual(["COMMIT_NOW", "ACT", ["ALL_CHECKS_PASSED"]]);
  });

  it("refuses when the total is above the caller's budget", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel")], { max_total_minor: 10_000 }), ctx);
    expect([plan.verdict, plan.decision.reason_codes]).toEqual(["DO_NOT_COMMIT", ["BUDGET_EXCEEDED"]]);
  });

  it("asks to revalidate when a leg has no price validity at all", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { clocks: {} })]), ctx);
    expect([plan.verdict, plan.decision.outcome, plan.decision.reason_codes]).toEqual([
      "REVALIDATE_FIRST",
      "UNKNOWN",
      ["MISSING_PRICE_VALIDITY"],
    ]);
  });

  it("asks to revalidate when a price has already expired", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { clocks: { price_valid_until: inMinutes(-1) } })]), ctx);
    expect(plan.decision.reason_codes).toEqual(["PRICE_VALIDITY_EXPIRED"]);
  });

  it("asks to revalidate when a price expires inside the safety margin", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { clocks: { price_valid_until: inMinutes(1) } })]), ctx);
    expect(plan.decision.reason_codes).toEqual(["PRICE_VALIDITY_NEAR_EXPIRY"]);
  });

  it("names a reconcile deadline on every UNKNOWN decision", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { clocks: {} })]), ctx);
    expect(plan.decision.reconcile_by).toBe(NOW.toISOString());
  });

  it("needs approval when irreversible exposure is above the autonomous cap", async () => {
    const plan = await planTrip(
      checkRequest([irreversibleWireLeg("flight", { price: { amount_minor: 60_000, currency: "USD" } })]),
      ctx,
    );
    expect([plan.verdict, plan.decision.required_role, plan.decision.reason_codes]).toEqual([
      "NEEDS_APPROVAL",
      "SESSION_APPROVER",
      ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"],
    ]);
  });

  it("refuses when irreversible exposure is above the caller's own cap", async () => {
    const plan = await planTrip(checkRequest([irreversibleWireLeg("flight")], { max_irreversible_minor: 5_000 }), ctx);
    expect([plan.decision.outcome, plan.decision.reason_codes]).toEqual(["REFUSE", ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"]]);
  });

  it("refuses a weakly held irreversible leg on readiness", async () => {
    const plan = await planTrip(checkRequest([irreversibleWireLeg("flight", { preparation_mode: "INSTANT_COMMIT_ONLY" })]), ctx);
    expect([plan.decision.reason_codes, plan.readiness.score < plan.readiness.minimum_required]).toEqual([
      ["READINESS_BELOW_THRESHOLD"],
      true,
    ]);
  });

  it("refuses an unsupported preparation mode", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { preparation_mode: "UNSUPPORTED" })]), ctx);
    expect(plan.decision.reason_codes).toEqual(["UNSUPPORTED_PREPARATION_MODE"]);
  });

  it("refuses a leg priced in another currency", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { price: { amount_minor: 100, currency: "EUR" } })]), ctx);
    expect(plan.decision.reason_codes).toEqual(["CURRENCY_MISMATCH"]);
  });

  it("refuses duplicate leg ids", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel"), wireLeg("hotel")]), ctx);
    expect(plan.decision.reason_codes).toEqual(["DUPLICATE_LEG_ID"]);
  });

  it("refuses a dependency on a leg that is not in the request", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel", { depends_on: ["ghost"] })]), ctx);
    expect(plan.decision.reason_codes).toEqual(["UNKNOWN_DEPENDENCY"]);
  });

  it("refuses a dependency cycle", async () => {
    const plan = await planTrip(
      checkRequest([wireLeg("a", { depends_on: ["b"] }), wireLeg("b", { depends_on: ["a"] })]),
      ctx,
    );
    expect(plan.decision.reason_codes).toEqual(["UNKNOWN_DEPENDENCY"]);
  });
});

describe("planTrip report", () => {
  it("scores a firmly held, refundable, long-valid leg at 100", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel")]), ctx);
    expect(plan.legs[0]!.readiness_score).toBe(100);
  });

  it("counts a non-refundable leg's full price as irreversible exposure", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel"), irreversibleWireLeg("flight")]), ctx);
    expect(plan.exposure).toEqual({ total_minor: 40_000, irreversible_minor: 20_000, currency: "USD" });
  });

  it("marks readiness as an unvalidated prior", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel")]), ctx);
    expect([plan.readiness.validated, plan.readiness.basis]).toEqual([false, "PRIOR"]);
  });

  it("marks caller-supplied legs as CALLER_ASSERTED evidence", () => {
    const [leg] = checkRequest([wireLeg("hotel")]).legs;
    expect(legFromCaller(leg!).evidence_grade).toBe("CALLER_ASSERTED");
  });

  it("binds the plan to its inputs through the decision's inputs hash", async () => {
    const plan = await planTrip(checkRequest([wireLeg("hotel")]), ctx);
    expect(plan.inputs_hash).toBe(plan.decision.inputs_hash);
  });

  it("gives the same inputs the same inputs hash", async () => {
    const request = checkRequest([wireLeg("hotel"), irreversibleWireLeg("flight")]);
    const [first, second] = await Promise.all([planTrip(request, ctx), planTrip(request, ctx)]);
    expect(first.inputs_hash).toBe(second.inputs_hash);
  });
});

describe("checkTrip", () => {
  it("returns a plan signed in the plan context", async () => {
    // #given a signing key and its published form
    const key = await generateSigningKey("test-key");
    const published = publishedKey(key, NOW.toISOString());

    // #when a trip is checked
    const signed = await checkTrip(checkRequest([wireLeg("hotel")]), { ...ctx, key });

    // #then anyone holding the published key can verify it
    expect(await verifyDocument(signed, "intyr/plan/v1", [published])).toEqual({ ok: true });
  });
});

const PREPARED: PreparedLegInput = {
  component_id: "cmp_flight",
  type: "FLIGHT",
  leg_class: "SUPPLIER_SANDBOX",
  evidence_grade: "SUPPLIER_SANDBOX",
  provider_id: "duffel",
  preparation_mode: "INSTANT_COMMIT_ONLY",
  refs: { offer_id: "off_123" },
  price: { amount_minor: 20_000, currency: "USD" },
  clocks: {
    price_valid_until: inMinutes(30),
    inventory_held_until: null,
    free_cancel_until: null,
    void_until: inMinutes(60),
    refund_destination: "UNKNOWN",
    refund_amount_certainty: "UNKNOWN",
    confirmation_mode: "INSTANT",
    supplier_can_cancel: false,
  },
  irreversible: true,
};

describe("legFromPrepared", () => {
  it("keeps the adapter's evidence grade and clocks", () => {
    const leg = legFromPrepared(PREPARED);
    expect([leg.leg_id, leg.evidence_grade, leg.refundable, leg.clocks]).toEqual([
      "cmp_flight",
      "SUPPLIER_SANDBOX",
      false,
      PREPARED.clocks,
    ]);
  });
});

describe("decidePrepare", () => {
  it("records a PREPARE decision for the trip with the same verdict the assessment reached", async () => {
    // #given a prepared leg inside a void window
    const legs = [legFromPrepared(PREPARED)];

    // #when the prepare gate runs
    const { assessment, decision } = await decidePrepare({
      trip_id: TRIP_ID,
      currency: "USD",
      legs,
      policy: PUBLIC_DEFAULT_POLICY,
      now: NOW,
    });

    // #then the decision is bound to the trip and mirrors the assessment
    expect([decision.gate, decision.subject, decision.outcome]).toEqual(["PREPARE", { trip_id: TRIP_ID }, assessment.outcome]);
  });

  it("reaches the same verdict as assessLegs for the same legs", async () => {
    const legs = [legFromPrepared(PREPARED)];
    const direct = assessLegs(legs, "USD", PUBLIC_DEFAULT_POLICY, NOW);
    const { assessment } = await decidePrepare({ trip_id: TRIP_ID, currency: "USD", legs, policy: PUBLIC_DEFAULT_POLICY, now: NOW });
    expect(assessment).toEqual(direct);
  });
});
