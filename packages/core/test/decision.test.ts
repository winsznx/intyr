import { describe, expect, it } from "vitest";
import { decisionChainIntact, decisionIntact, DecisionShapeError, makeDecision, type DecisionInput } from "../src/decision";
import { NOW, TRIP_ID } from "./fixtures";

function input(patch: Partial<DecisionInput> = {}): DecisionInput {
  return {
    gate: "COMMIT",
    subject: { trip_id: TRIP_ID },
    outcome: "ACT",
    reason_codes: ["ALL_CHECKS_PASSED"],
    inputs: { total_minor: 40_000 },
    policy_version: "public-default-v1",
    now: NOW,
    ...patch,
  };
}

describe("makeDecision", () => {
  it("refuses to record a refusal without a reason", async () => {
    await expect(makeDecision(input({ outcome: "REFUSE", reason_codes: [] }))).rejects.toThrow(DecisionShapeError);
  });

  it("refuses to record UNKNOWN without a reconcile deadline", async () => {
    await expect(makeDecision(input({ outcome: "UNKNOWN", reason_codes: ["COMPONENT_STATUS_UNKNOWN"] }))).rejects.toThrow(
      DecisionShapeError,
    );
  });

  it("refuses to record MANUAL_REVIEW without naming who decides", async () => {
    await expect(makeDecision(input({ outcome: "MANUAL_REVIEW", reason_codes: ["APPROVAL_REQUIRED"] }))).rejects.toThrow(
      DecisionShapeError,
    );
  });

  it("hashes a Date input the same as its ISO string", async () => {
    const withDate = await makeDecision(input({ inputs: { at: NOW } }));
    const withString = await makeDecision(input({ inputs: { at: NOW.toISOString() } }));
    expect(withDate.inputs_hash).toBe(withString.inputs_hash);
  });

  it("hashes an undefined optional field the same as an omitted one", async () => {
    const withUndefined = await makeDecision(input({ inputs: { a: 1, b: undefined } }));
    const omitted = await makeDecision(input({ inputs: { a: 1 } }));
    expect(withUndefined.inputs_hash).toBe(omitted.inputs_hash);
  });
});

describe("decision integrity", () => {
  it("detects a decision altered after it was made", async () => {
    const decision = await makeDecision(input());
    expect([await decisionIntact(decision), await decisionIntact({ ...decision, outcome: "REFUSE" })]).toEqual([true, false]);
  });

  it("detects a broken hash chain", async () => {
    // #given three decisions chained in order
    const first = await makeDecision(input());
    const second = await makeDecision(input({ prev_decision_hash: first.decision_hash }));
    const third = await makeDecision(input({ prev_decision_hash: second.decision_hash }));

    // #then the chain holds in order and breaks when one is dropped
    expect([decisionChainIntact([first, second, third]), decisionChainIntact([first, third])]).toEqual([true, false]);
  });
});
