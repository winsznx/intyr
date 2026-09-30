import { describe, expect, it } from "vitest";
import { recoverySentence } from "./recovery";
import type { Trip, TripComponent } from "./types";

function leg(type: string, state: TripComponent["state"]): TripComponent {
  return { component_id: `${type.toLowerCase()}-1`, type, state };
}

function trip(components: TripComponent[]): Trip {
  return { trip_id: "trp_000000000000000000000001", state: "RECOVERED", components };
}

describe("recoverySentence", () => {
  it("names the failed leg, what was cancelled, and that nothing is left booked", () => {
    const text = recoverySentence(trip([leg("GROUND", "CANCELLED"), leg("HOTEL", "CANCELLED"), leg("FLIGHT", "COMMIT_FAILED")]));
    expect(text).toBe("Flight failed at commit. Ground transfer and hotel cancelled inside the limit. Nothing left booked.");
  });

  it("says what is still booked instead of claiming a clean unwind", () => {
    const text = recoverySentence(trip([leg("HOTEL", "CONFIRMED"), leg("FLIGHT", "COMMIT_FAILED")]));
    expect(text).toBe("Flight failed at commit. Still booked: hotel.");
  });
});

import { approvalState } from "./recovery";

describe("approvalState", () => {
  const base: Trip = { trip_id: "trp_1", state: "PREPARED_WITH_WARNINGS", components: [], approval: { required: true } };

  it("needs a decision while commit is blocked for approval", () => {
    expect(approvalState({ ...base, next_actions: [{ action: "COMMIT", allowed: false, reason: "APPROVAL_REQUIRED" }, { action: "REQUEST_APPROVAL", allowed: true }] })).toBe("NEEDED");
  });

  it("treats an allowed commit on a trip that required approval as approved", () => {
    expect(approvalState({ ...base, next_actions: [{ action: "COMMIT", allowed: true }] })).toBe("GIVEN");
  });

  it("reports no approval when none was ever required", () => {
    expect(approvalState({ ...base, approval: undefined, next_actions: [{ action: "COMMIT", allowed: true }] })).toBe("NONE");
  });
});
