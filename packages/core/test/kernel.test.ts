import { describe, expect, it } from "vitest";
import {
  componentStateAfterConfirm,
  decideCommit,
  decideComponentConfirm,
  decidePaymentAccept,
  decideRecoveryAction,
  decideRefund,
  type CommitGateInput,
  type ConfirmGateInput,
  type PaymentBinding,
  type PaymentGateInput,
  type ReadObservation,
  type RecoveryGateInput,
} from "../src/kernel";
import type { GateDecision } from "../src/types";
import { HASH_A, HASH_B, inMinutes, NOW, TRIP_ID } from "./fixtures";

const POLICY_VERSION = "public-default-v1";
const outcomeOf = (d: GateDecision) => [d.outcome, d.reason_codes];

// ---------------------------------------------------------------- COMMIT

function commitInput(patch: {
  trip?: Partial<CommitGateInput["trip"]>;
  manifest?: Partial<NonNullable<CommitGateInput["manifest"]>> | null;
  request?: Partial<CommitGateInput["request"]>;
  approval?: CommitGateInput["approval"];
} = {}): CommitGateInput {
  return {
    trip: {
      trip_id: TRIP_ID,
      state: "READY_TO_COMMIT",
      commit_manifest_hash: null,
      component_states: ["PREPARED", "PREPARED"],
      ...patch.trip,
    },
    manifest:
      patch.manifest === null
        ? null
        : {
            manifest_id: "man_1",
            manifest_hash: HASH_A,
            status: "ACTIVE",
            expires_at: inMinutes(10),
            currency: "USD",
            total_minor: 40_000,
            prepare_decision: { outcome: "ACT", reason_codes: ["ALL_CHECKS_PASSED"] },
            ...patch.manifest,
          },
    request: {
      trip_id: TRIP_ID,
      manifest_id: "man_1",
      manifest_hash: HASH_A,
      maximum_total_minor: 40_000,
      currency: "USD",
      recovery_policy_acknowledged: true,
      ...patch.request,
    },
    approval: patch.approval ?? null,
    policy_version: POLICY_VERSION,
    now: NOW,
  };
}

describe("decideCommit", () => {
  it("acts when the named manifest is active, unchanged and within the caller's maximum", async () => {
    expect(outcomeOf(await decideCommit(commitInput()))).toEqual(["ACT", ["ALL_CHECKS_PASSED"]]);
  });

  it("treats a repeated commit for the in-flight manifest as a replay", async () => {
    // #given a commit that already started under manifest A
    const input = commitInput({ trip: { state: "COMMITTING", commit_manifest_hash: HASH_A } });

    // #when the same commit arrives again
    const decision = await decideCommit(input);

    // #then nothing new is attempted
    expect(outcomeOf(decision)).toEqual(["NO_ACTION", ["COMMIT_ALREADY_STARTED"]]);
  });

  it("refuses a commit for another manifest while one is in flight", async () => {
    const input = commitInput({ trip: { state: "COMMITTING", commit_manifest_hash: HASH_B } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["TRIP_STATE_CONFLICT"]]);
  });

  it("counts any component past PREPARED as a started commit, whatever the trip state says", async () => {
    // #given a trip in review after a commit left one component unknown
    const input = commitInput({
      trip: { state: "MANUAL_REVIEW", commit_manifest_hash: HASH_A, component_states: ["CONFIRMED", "COMMIT_STATUS_UNKNOWN"] },
    });
    expect(outcomeOf(await decideCommit(input))).toEqual(["NO_ACTION", ["COMMIT_ALREADY_STARTED"]]);
  });

  it("reports a completed commit instead of repeating it", async () => {
    const input = commitInput({ trip: { state: "COMMITTED", commit_manifest_hash: HASH_A } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["NO_ACTION", ["COMMIT_ALREADY_COMPLETED"]]);
  });

  it("refuses when the trip has no manifest by that id", async () => {
    expect(outcomeOf(await decideCommit(commitInput({ manifest: null })))).toEqual(["REFUSE", ["MANIFEST_NOT_FOUND"]]);
  });

  it("refuses when the caller's manifest hash differs from the stored one", async () => {
    const input = commitInput({ request: { manifest_hash: HASH_B } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["MANIFEST_HASH_MISMATCH"]]);
  });

  it("refuses a superseded manifest", async () => {
    const input = commitInput({ manifest: { status: "SUPERSEDED" } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["MANIFEST_SUPERSEDED"]]);
  });

  it("refuses a manifest past its expiry", async () => {
    const input = commitInput({ manifest: { expires_at: inMinutes(-1) } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["MANIFEST_EXPIRED"]]);
  });

  it("refuses when the manifest total is above the caller's maximum", async () => {
    const input = commitInput({ request: { maximum_total_minor: 39_999 } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["PRICE_ABOVE_MAXIMUM"]]);
  });

  it("refuses when a component is no longer committable", async () => {
    const input = commitInput({ trip: { component_states: ["PREPARED", "PRICE_UNCERTAIN"] } });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["COMPONENT_NOT_READY"]]);
  });

  it("carries an unknown prepare verdict forward as a refusal to revalidate", async () => {
    const input = commitInput({ manifest: { prepare_decision: { outcome: "UNKNOWN", reason_codes: ["PRICE_VALIDITY_NEAR_EXPIRY"] } } });
    const decision = await decideCommit(input);
    expect([decision.outcome, decision.reason_codes, decision.next_actions[0]?.action]).toEqual([
      "REFUSE",
      ["PRICE_VALIDITY_NEAR_EXPIRY"],
      "REVALIDATE",
    ]);
  });

  it("asks the session approver when the prepare verdict needs approval and none exists", async () => {
    const input = commitInput({
      manifest: { prepare_decision: { outcome: "MANUAL_REVIEW", reason_codes: ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"] } },
    });
    const decision = await decideCommit(input);
    expect([decision.outcome, decision.reason_codes, decision.required_role]).toEqual([
      "MANUAL_REVIEW",
      ["APPROVAL_REQUIRED"],
      "SESSION_APPROVER",
    ]);
  });

  it("refuses an approval that was granted for a different manifest", async () => {
    const input = commitInput({
      manifest: { prepare_decision: { outcome: "MANUAL_REVIEW", reason_codes: ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"] } },
      approval: { manifest_hash: HASH_B },
    });
    expect(outcomeOf(await decideCommit(input))).toEqual(["REFUSE", ["APPROVAL_INVALID"]]);
  });

  it("acts on an approval bound to the same manifest", async () => {
    const input = commitInput({
      manifest: { prepare_decision: { outcome: "MANUAL_REVIEW", reason_codes: ["IRREVERSIBLE_EXPOSURE_ABOVE_CAP"] } },
      approval: { manifest_hash: HASH_A },
    });
    expect((await decideCommit(input)).outcome).toBe("ACT");
  });

  it("chains the decision to the previous one for the same trip", async () => {
    const first = await decideCommit(commitInput());
    const second = await decideCommit(commitInput(), first.decision_hash);
    expect(second.prev_decision_hash).toBe(first.decision_hash);
  });
});

// ---------------------------------------------------- COMPONENT_CONFIRM

const PRICE = { amount_minor: 20_000, currency: "USD" };
const SUBMITTED_AT = new Date(NOW.getTime() - 30_000);

function read(patch: Partial<ReadObservation> = {}): ReadObservation {
  return { found: "PRESENT", confirmed: true, cancelled: false, absent_is_final: false, price: PRICE, evidence_tier: "E1", ...patch };
}

function confirmInput(patch: Partial<ConfirmGateInput> = {}): ConfirmGateInput {
  return {
    trip_id: TRIP_ID,
    component_id: "cmp_1",
    write: { response: "RESPONDED_CONFIRMED", no_booking_certain: false },
    read: read(),
    expected_price: PRICE,
    price_tolerance_minor: 400,
    submitted_at: SUBMITTED_AT,
    reconcile_window_seconds: 900,
    policy_version: POLICY_VERSION,
    now: NOW,
    ...patch,
  };
}

describe("decideComponentConfirm", () => {
  it("confirms only after an independent read finds the booking at the expected price", async () => {
    expect(outcomeOf(await decideComponentConfirm(confirmInput()))).toEqual(["ACT", ["SUPPLIER_CONFIRMED"]]);
  });

  it("keeps a supplier's 'confirmed' response UNKNOWN until a read backs it", async () => {
    // #given the supplier said confirmed but no read has happened
    const decision = await decideComponentConfirm(confirmInput({ read: null }));

    // #then the component is unknown, with a deadline to reconcile by
    expect([decision.outcome, decision.reconcile_by]).toEqual([
      "UNKNOWN",
      new Date(SUBMITTED_AT.getTime() + 900_000).toISOString(),
    ]);
  });

  it("keeps a timeout UNKNOWN while an absent read is not yet final", async () => {
    const input = confirmInput({
      write: { response: "UNKNOWN", no_booking_certain: false },
      read: read({ found: "ABSENT", confirmed: false }),
    });
    expect(outcomeOf(await decideComponentConfirm(input))).toEqual(["UNKNOWN", ["COMPONENT_STATUS_UNKNOWN"]]);
  });

  it("accepts a final absent read as proof that nothing was booked", async () => {
    const input = confirmInput({
      write: { response: "UNKNOWN", no_booking_certain: false },
      read: read({ found: "ABSENT", confirmed: false, absent_is_final: true }),
    });
    expect(outcomeOf(await decideComponentConfirm(input))).toEqual(["NO_ACTION", ["NEGATIVE_CONFIRMATION"]]);
  });

  it("accepts a rejection the supplier documents as leaving no booking", async () => {
    const input = confirmInput({ write: { response: "REJECTED", no_booking_certain: true }, read: null });
    expect(outcomeOf(await decideComponentConfirm(input))).toEqual(["REFUSE", ["SUPPLIER_REJECTED"]]);
  });

  it("does not treat a rejection without that guarantee as a failure", async () => {
    const input = confirmInput({ write: { response: "REJECTED", no_booking_certain: false }, read: null });
    expect((await decideComponentConfirm(input)).outcome).toBe("UNKNOWN");
  });

  it("keeps a present but unconfirmed booking UNKNOWN", async () => {
    const input = confirmInput({ read: read({ confirmed: false }) });
    expect((await decideComponentConfirm(input)).outcome).toBe("UNKNOWN");
  });

  it("treats a booking the read finds cancelled as failed", async () => {
    const input = confirmInput({ read: read({ cancelled: true }) });
    expect(outcomeOf(await decideComponentConfirm(input))).toEqual(["REFUSE", ["SUPPLIER_REJECTED"]]);
  });

  it("sends a booking found at a different price to an operator", async () => {
    const input = confirmInput({ read: read({ price: { amount_minor: 25_000, currency: "USD" } }) });
    const decision = await decideComponentConfirm(input);
    expect([decision.outcome, decision.reason_codes, decision.required_role]).toEqual([
      "MANUAL_REVIEW",
      ["POSTCONDITION_MISMATCH"],
      "INTYR_OPERATOR",
    ]);
  });

  it("sends an outcome still unresolved after the reconcile window to an operator", async () => {
    const input = confirmInput({
      write: { response: "UNKNOWN", no_booking_certain: false },
      read: read({ found: "UNKNOWN", confirmed: false }),
      now: new Date(SUBMITTED_AT.getTime() + 901_000),
    });
    const decision = await decideComponentConfirm(input);
    expect([decision.outcome, decision.reason_codes, decision.required_role]).toEqual([
      "MANUAL_REVIEW",
      ["COMPONENT_STATUS_UNKNOWN"],
      "INTYR_OPERATOR",
    ]);
  });

  it("treats a missing response like any other unknown write", async () => {
    const input = confirmInput({ write: null, read: null });
    expect((await decideComponentConfirm(input)).outcome).toBe("UNKNOWN");
  });
});

describe("componentStateAfterConfirm", () => {
  it.each([
    { name: "a confirmed read", input: confirmInput(), state: "CONFIRMED" },
    { name: "an unbacked response", input: confirmInput({ read: null }), state: "COMMIT_STATUS_UNKNOWN" },
    {
      name: "a final absent read",
      input: confirmInput({ read: read({ found: "ABSENT", confirmed: false, absent_is_final: true }) }),
      state: "COMMIT_FAILED",
    },
    {
      name: "a price mismatch, because the booking still exists",
      input: confirmInput({ read: read({ price: { amount_minor: 25_000, currency: "USD" } }) }),
      state: "CONFIRMED",
    },
    {
      name: "an expired reconcile window",
      input: confirmInput({ read: null, write: null, now: new Date(SUBMITTED_AT.getTime() + 901_000) }),
      state: "COMMIT_STATUS_UNKNOWN",
    },
  ])("maps $name to $state", async ({ input, state }) => {
    expect(componentStateAfterConfirm(await decideComponentConfirm(input))).toBe(state);
  });
});

// ----------------------------------------------------- RECOVERY_ACTION

function recoveryInput(
  component: Partial<RecoveryGateInput["component"]> = {},
  patch: Partial<Omit<RecoveryGateInput, "component">> = {},
): RecoveryGateInput {
  return {
    trip_id: TRIP_ID,
    component: {
      component_id: "cmp_1",
      state: "CONFIRMED",
      required: true,
      price: PRICE,
      refundable: true,
      cancellation_fee_minor: null,
      free_cancel_until: inMinutes(60),
      void_until: null,
      has_hold: false,
      ...component,
    },
    cancel_quote: null,
    replacement: { allowed: false, candidate_price_minor: null },
    headroom_minor: 0,
    policy_version: POLICY_VERSION,
    now: NOW,
    ...patch,
  };
}

async function recovery(input: RecoveryGateInput) {
  const { decision, action } = await decideRecoveryAction(input);
  return [decision.outcome, decision.reason_codes, action];
}

describe("decideRecoveryAction", () => {
  it("cancels a confirmed booking inside its free cancellation window", async () => {
    expect(await recovery(recoveryInput())).toEqual(["ACT", ["CANCEL_WITHIN_FREE_WINDOW"], "CANCEL"]);
  });

  it("voids a non-refundable booking while its void window is open", async () => {
    const input = recoveryInput({ refundable: false, free_cancel_until: null, void_until: inMinutes(30) });
    expect(await recovery(input)).toEqual(["ACT", ["CANCEL_WITHIN_FREE_WINDOW"], "CANCEL"]);
  });

  it("keeps an irreversible booking instead of pretending to undo it", async () => {
    const input = recoveryInput({ refundable: false, free_cancel_until: null });
    expect(await recovery(input)).toEqual(["REFUSE", ["IRREVERSIBLE_COMPONENT"], "KEEP"]);
  });

  it("never acts on a component whose commit outcome is unknown", async () => {
    const { decision, action } = await decideRecoveryAction(recoveryInput({ state: "COMMIT_STATUS_UNKNOWN" }));
    expect([decision.outcome, action, decision.reconcile_by !== undefined]).toEqual(["UNKNOWN", "NONE", true]);
  });

  it("waits for a cancellation that is still in flight", async () => {
    expect((await recovery(recoveryInput({ state: "CANCELLING" })))[0]).toBe("UNKNOWN");
  });

  it("keeps a booking the supplier's quote says cannot be cancelled", async () => {
    const input = recoveryInput({}, { cancel_quote: { cancellable: false, fee_minor: null } });
    expect(await recovery(input)).toEqual(["REFUSE", ["CANCEL_REFUSED_BY_SUPPLIER"], "KEEP"]);
  });

  it("pays a quoted fee that fits inside the headroom", async () => {
    const input = recoveryInput({ free_cancel_until: null }, { cancel_quote: { cancellable: true, fee_minor: 1_500 }, headroom_minor: 2_000 });
    expect(await recovery(input)).toEqual(["ACT", ["CANCEL_WITH_FEE"], "CANCEL"]);
  });

  it("asks before paying a quoted fee above the headroom", async () => {
    const input = recoveryInput({}, { cancel_quote: { cancellable: true, fee_minor: 1_500 }, headroom_minor: 1_000 });
    expect(await recovery(input)).toEqual(["MANUAL_REVIEW", ["ADDITIONAL_SPEND_REQUIRED"], "NONE"]);
  });

  it("asks before cancelling when the fee is unknown and the free window has closed", async () => {
    const input = recoveryInput({ free_cancel_until: inMinutes(-5) });
    expect(await recovery(input)).toEqual(["MANUAL_REVIEW", ["ADDITIONAL_SPEND_REQUIRED"], "NONE"]);
  });

  it("replaces a failed required component when the replacement fits the headroom", async () => {
    const input = recoveryInput(
      { state: "COMMIT_FAILED" },
      { replacement: { allowed: true, candidate_price_minor: 21_000 }, headroom_minor: 2_000 },
    );
    expect(await recovery(input)).toEqual(["ACT", ["REPLACEMENT_WITHIN_HEADROOM"], "REPLACE"]);
  });

  it("asks before a replacement that costs more than the headroom", async () => {
    const input = recoveryInput(
      { state: "COMMIT_FAILED" },
      { replacement: { allowed: true, candidate_price_minor: 25_000 }, headroom_minor: 2_000 },
    );
    expect(await recovery(input)).toEqual(["MANUAL_REVIEW", ["ADDITIONAL_SPEND_REQUIRED"], "NONE"]);
  });

  it("does not replace when the caller did not allow it", async () => {
    const input = recoveryInput({ state: "COMMIT_FAILED" });
    expect(await recovery(input)).toEqual(["NO_ACTION", ["OUTSIDE_RECOVERY_BOUNDARY"], "NONE"]);
  });

  it("reports when no replacement is available", async () => {
    const input = recoveryInput({ state: "COMMIT_FAILED" }, { replacement: { allowed: true, candidate_price_minor: null } });
    expect(await recovery(input)).toEqual(["NO_ACTION", ["NO_REPLACEMENT_AVAILABLE"], "NONE"]);
  });

  it("releases a hold on a component that was never committed", async () => {
    expect(await recovery(recoveryInput({ state: "PREPARED", has_hold: true }))).toEqual([
      "ACT",
      ["RELEASE_UNCOMMITTED_HOLD"],
      "CANCEL",
    ]);
  });

  it("leaves an uncommitted component without a hold alone", async () => {
    expect(await recovery(recoveryInput({ state: "PREPARED" }))).toEqual(["NO_ACTION", ["NOTHING_TO_RECOVER"], "NONE"]);
  });

  it("does nothing for a component that is already cancelled", async () => {
    expect(await recovery(recoveryInput({ state: "CANCELLED" }))).toEqual(["NO_ACTION", ["ALREADY_CANCELLED"], "NONE"]);
  });
});

// ------------------------------------------------------ PAYMENT_ACCEPT

const BINDING: PaymentBinding = {
  session_id: "pay_1",
  route: "POST /v1/trips/check",
  body_hash: HASH_A,
  network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  asset_id: 10458941,
  amount_minor: 10_000,
  pay_to: "PAYTOADDRESS",
  manifest_hash: null,
};

function paymentInput(observed: Partial<PaymentBinding> = {}, patch: Partial<PaymentGateInput> = {}): PaymentGateInput {
  return {
    expected: { ...BINDING, expires_at: inMinutes(5) },
    observed: { ...BINDING, ...observed },
    session_state: "PROOF_RECEIVED",
    policy_version: POLICY_VERSION,
    now: NOW,
    ...patch,
  };
}

describe("decidePaymentAccept", () => {
  it("accepts a payment that matches every bound field", async () => {
    expect(outcomeOf(await decidePaymentAccept(paymentInput()))).toEqual(["ACT", ["ALL_CHECKS_PASSED"]]);
  });

  it.each([
    { field: "network", observed: { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }, reason: "PAYMENT_WRONG_NETWORK" },
    { field: "asset", observed: { asset_id: 31566704 }, reason: "PAYMENT_WRONG_ASSET" },
    { field: "amount", observed: { amount_minor: 9_999 }, reason: "PAYMENT_WRONG_AMOUNT" },
    { field: "receiver", observed: { pay_to: "SOMEONEELSE" }, reason: "PAYMENT_WRONG_RECEIVER" },
    { field: "request body", observed: { body_hash: HASH_B }, reason: "PAYMENT_BINDING_MISMATCH" },
    { field: "manifest", observed: { manifest_hash: HASH_B }, reason: "PAYMENT_BINDING_MISMATCH" },
  ])("refuses a payment with the wrong $field", async ({ observed, reason }) => {
    expect(outcomeOf(await decidePaymentAccept(paymentInput(observed)))).toEqual(["REFUSE", [reason]]);
  });

  it("treats a settled session replayed with the same request as a replay", async () => {
    const input = paymentInput({}, { session_state: "SETTLED" });
    expect(outcomeOf(await decidePaymentAccept(input))).toEqual(["NO_ACTION", ["IDEMPOTENT_REPLAY"]]);
  });

  it("refuses to spend a settled session on a different request", async () => {
    const input = paymentInput({ body_hash: HASH_B }, { session_state: "CONFIRMED" });
    expect(outcomeOf(await decidePaymentAccept(input))).toEqual(["REFUSE", ["PAYMENT_ALREADY_CONSUMED"]]);
  });

  it("keeps a settlement with an unknown result UNKNOWN instead of asking to pay again", async () => {
    const decision = await decidePaymentAccept(paymentInput({}, { session_state: "UNKNOWN" }));
    expect([decision.outcome, decision.reason_codes, decision.reconcile_by !== undefined]).toEqual([
      "UNKNOWN",
      ["PAYMENT_SETTLEMENT_UNKNOWN"],
      true,
    ]);
  });

  it("refuses a session past its expiry", async () => {
    const input = paymentInput({}, { expected: { ...BINDING, expires_at: inMinutes(-1) } });
    expect(outcomeOf(await decidePaymentAccept(input))).toEqual(["REFUSE", ["PAYMENT_SESSION_EXPIRED"]]);
  });
});

// --------------------------------------------------------------- REFUND

describe("decideRefund", () => {
  const base = { session_id: "pay_1", amount_minor: 10_000, policy_version: POLICY_VERSION, now: NOW };

  it("keeps the fee when the paid outcome was delivered", async () => {
    const decision = await decideRefund({ ...base, environment: "MAINNET", delivery: "DELIVERED" });
    expect(outcomeOf(decision)).toEqual(["NO_ACTION", ["FEE_KEPT_OUTCOME_DELIVERED"]]);
  });

  it("refunds a TestNet fee automatically when Intyr failed to deliver", async () => {
    const decision = await decideRefund({ ...base, environment: "TESTNET", delivery: "INTYR_FAILURE" });
    expect(outcomeOf(decision)).toEqual(["ACT", ["FEE_REFUND_INTYR_FAILURE"]]);
  });

  it("routes a Mainnet refund to an operator instead of sending it automatically", async () => {
    const decision = await decideRefund({ ...base, environment: "MAINNET", delivery: "COMMIT_NOT_EXECUTED" });
    expect([decision.outcome, decision.reason_codes, decision.required_role]).toEqual([
      "MANUAL_REVIEW",
      ["FEE_REFUND_DEFERRED_MAINNET"],
      "INTYR_OPERATOR",
    ]);
  });
});
