import { describe, expect, it } from "vitest";
import { nextCommitStep, UnknownComponentError, type SagaComponent } from "../src/saga";
import type { ComponentState } from "../src/vocab";

const ORDER = ["hotel", "flight", "transfer"];

function components(states: [ComponentState, ComponentState, ComponentState], required = [true, true, true]): SagaComponent[] {
  return ORDER.map((component_id, i) => ({ component_id, state: states[i]!, required: required[i]! }));
}

describe("nextCommitStep", () => {
  it("submits the first component in commit order", () => {
    expect(nextCommitStep(ORDER, components(["PREPARED", "PREPARED", "PREPARED"]))).toEqual({ kind: "SUBMIT", component_id: "hotel" });
  });

  it("moves on to the next component once the previous one is confirmed", () => {
    expect(nextCommitStep(ORDER, components(["CONFIRMED", "PREPARED", "PREPARED"]))).toEqual({ kind: "SUBMIT", component_id: "flight" });
  });

  it("reconciles an unknown write before submitting anything else", () => {
    // #given the flight's commit outcome is unknown and the transfer is ready
    const step = nextCommitStep(ORDER, components(["CONFIRMED", "COMMIT_STATUS_UNKNOWN", "PREPARED"]));

    // #then the saga stops at the flight instead of booking the transfer
    expect(step).toEqual({ kind: "RECONCILE", component_id: "flight" });
  });

  it("reconciles a write that was submitted but never answered", () => {
    expect(nextCommitStep(ORDER, components(["COMMIT_SUBMITTED", "PREPARED", "PREPARED"]))).toEqual({
      kind: "RECONCILE",
      component_id: "hotel",
    });
  });

  it("starts recovery when a required component fails", () => {
    expect(nextCommitStep(ORDER, components(["CONFIRMED", "COMMIT_FAILED", "PREPARED"]))).toEqual({
      kind: "RECOVER",
      failed_component_id: "flight",
    });
  });

  it("skips a failed optional component", () => {
    expect(nextCommitStep(ORDER, components(["CONFIRMED", "CONFIRMED", "COMMIT_FAILED"], [true, true, false]))).toEqual({
      kind: "COMPLETE",
    });
  });

  it("completes when every component is confirmed", () => {
    expect(nextCommitStep(ORDER, components(["CONFIRMED", "CONFIRMED", "CONFIRMED"]))).toEqual({ kind: "COMPLETE" });
  });

  it("halts on a state the commit saga does not own", () => {
    expect(nextCommitStep(ORDER, components(["CANCELLING", "PREPARED", "PREPARED"]))).toEqual({
      kind: "HALT",
      component_id: "hotel",
      state: "CANCELLING",
    });
  });

  it("throws when the order names a component the trip does not have", () => {
    expect(() => nextCommitStep(["ghost"], components(["PREPARED", "PREPARED", "PREPARED"]))).toThrow(UnknownComponentError);
  });
});
