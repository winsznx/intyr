import { describe, expect, it } from "vitest";
import {
  COMPONENT_STATES,
  DECISION_OUTCOMES,
  EVIDENCE_GRADES,
  LEG_CLASSES,
  PREPARATION_MODES,
  PROOF_STATES,
  REASON_CODES,
  TRIP_STATES,
} from "@intyr/core";
import { COMPONENT_STATE, DECISION, EVIDENCE_GRADE, LEG_CLASS, PREPARATION_MODE, PROOF_STATE, TRIP_STATE, hasReasonCopy } from "./labels";

describe("every name in the core vocabulary has UI copy", () => {
  it.each([...TRIP_STATES])("trip state %s", (state) => {
    expect(TRIP_STATE[state as keyof typeof TRIP_STATE]?.label).toBeTruthy();
  });

  it.each([...COMPONENT_STATES])("component state %s", (state) => {
    expect(COMPONENT_STATE[state as keyof typeof COMPONENT_STATE]?.label).toBeTruthy();
  });

  it.each([...DECISION_OUTCOMES])("decision outcome %s", (outcome) => {
    expect(DECISION[outcome].label).toBe(outcome);
  });

  it.each([...PROOF_STATES])("proof state %s", (state) => {
    expect(PROOF_STATE[state as keyof typeof PROOF_STATE]?.explain).toBeTruthy();
  });

  it.each([...PREPARATION_MODES])("preparation mode %s", (mode) => {
    expect(PREPARATION_MODE[mode as keyof typeof PREPARATION_MODE]?.label).toBeTruthy();
  });

  it.each([...EVIDENCE_GRADES])("evidence grade %s", (grade) => {
    expect(EVIDENCE_GRADE[grade as keyof typeof EVIDENCE_GRADE]?.label).toBeTruthy();
  });

  it.each([...LEG_CLASSES])("leg class %s", (legClass) => {
    expect(LEG_CLASS[legClass as keyof typeof LEG_CLASS]).toBeTruthy();
  });

  it.each([...REASON_CODES])("reason code %s", (code) => {
    expect(hasReasonCopy(code)).toBe(true);
  });
});

describe("truth before display", () => {
  it("never shows an authorized action as done", () => {
    expect(DECISION.ACT.tone).not.toBe("success");
  });

  it("only verified states use the success tone", () => {
    const success = Object.entries(TRIP_STATE).filter(([, v]) => v.tone === "success").map(([k]) => k);
    expect(success).toEqual(["COMMITTED"]);
    const confirmed = Object.entries(COMPONENT_STATE).filter(([, v]) => v.tone === "success").map(([k]) => k);
    expect(confirmed).toEqual(["CONFIRMED"]);
  });

  it("marks unknown outcomes as still running, never terminal", () => {
    expect(TRIP_STATE.COMMIT_STATUS_UNKNOWN.terminal).toBeFalsy();
    expect(COMPONENT_STATE.COMMIT_STATUS_UNKNOWN.terminal).toBeFalsy();
  });
});
