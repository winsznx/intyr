import { describe, expect, it } from "vitest";
import { receiptRecord } from "./receipt";
import type { Trip } from "./types";

const COMMIT_ID = "man_3539fac1776adf76a1772e2c";
const COMMIT_HASH = "sha256:eaace8e6931b09ec49f88391a57d075d091b128ee79aa6fc1e0432429a2244f4";
const FINAL_ID = "man_b00f74409609cb92bb2beadc";

const prepared: Trip = {
  trip_id: "trp_1",
  state: "READY_TO_COMMIT",
  components: [],
  manifest_id: COMMIT_ID,
  initial_manifest_id: COMMIT_ID,
  manifest_hash: COMMIT_HASH,
};

describe("receiptRecord", () => {
  it("pairs the commit manifest with its own hash before commit", () => {
    expect(receiptRecord(prepared)).toEqual({ id: COMMIT_ID, hash: COMMIT_HASH });
  });

  it("never pairs the final manifest with the commit manifest's hash", () => {
    const committed: Trip = { ...prepared, state: "COMMITTED", manifest_id: FINAL_ID, final_manifest_id: FINAL_ID };
    expect(receiptRecord(committed)).toEqual({ id: FINAL_ID });
  });

  it("shows a checked plan by id only", () => {
    expect(receiptRecord({ trip_id: "trp_2", state: "CHECKED", components: [], manifest_id: "pln_1", plan_id: "pln_1" })).toEqual({ id: "pln_1" });
  });

  it("has nothing to show before anything is signed", () => {
    expect(receiptRecord({ trip_id: "trp_3", state: "PREPARING", components: [] })).toBeUndefined();
  });
});
