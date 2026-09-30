import type { SimOrder } from "@intyr/adapters";

import type { ArmReport, BeliefState, TripSpec } from "./types";

/**
 * Independent auditor. It reads only the supplier-side order list (the
 * simulator's ground truth) and the arm's own report. It shares no code with
 * any arm, and it never trusts a response an arm received.
 */

export type TripOutcome = "COMPLETE" | "UNWOUND" | "INCONSISTENT";

export interface ComponentTruth {
  component_id: string;
  live_orders: number;
  pending_orders: number;
  cancelled_orders: number;
  truth: BeliefState;
  arm_belief: BeliefState | "NOT_REPORTED";
  belief_matches: boolean;
}

export interface AuditResult {
  trip_id: string;
  arm: string;
  outcome: TripOutcome;
  inconsistency: "ORPHAN" | "DUPLICATE" | "UNRESOLVED" | null;
  duplicate_orders: number;
  orphan_value_minor: number;
  belief_mismatches: number;
  belief_unknowns: number;
  arm_verdict: ArmReport["verdict"];
  components: ComponentTruth[];
}

function normalize(belief: BeliefState | "NOT_REPORTED"): BeliefState | "NOT_REPORTED" {
  return belief === "CANCELLED" ? "NOT_BOOKED" : belief;
}

export function auditTrip(trip: TripSpec, orders: SimOrder[], report: ArmReport): AuditResult {
  const components: ComponentTruth[] = trip.components.map((c) => {
    const mine = orders.filter((o) => o.component_id === c.component_id);
    const live = mine.filter((o) => o.status === "CONFIRMED").length;
    const pending = mine.filter((o) => o.status === "PENDING").length;
    const cancelled = mine.filter((o) => o.status === "CANCELLED").length;
    const truth: BeliefState = pending > 0 ? "UNKNOWN" : live > 0 ? "BOOKED" : "NOT_BOOKED";
    const reported = report.components.find((b) => b.component_id === c.component_id);
    // A component the arm never reached is, in its own world, not booked.
    const armBelief: BeliefState | "NOT_REPORTED" = reported ? reported.belief : "NOT_REPORTED";
    const comparable = armBelief === "NOT_REPORTED" ? "NOT_BOOKED" : normalize(armBelief);
    return {
      component_id: c.component_id,
      live_orders: live,
      pending_orders: pending,
      cancelled_orders: cancelled,
      truth,
      arm_belief: armBelief,
      belief_matches: comparable === truth,
    };
  });

  const duplicates = components.reduce((n, c) => n + Math.max(0, c.live_orders - 1), 0);
  const unresolved = components.some((c) => c.pending_orders > 0);
  const allOne = components.every((c) => c.live_orders === 1);
  const allZero = components.every((c) => c.live_orders === 0) && !unresolved;
  let outcome: TripOutcome = "INCONSISTENT";
  let inconsistency: AuditResult["inconsistency"] = null;
  if (!unresolved && allOne) outcome = "COMPLETE";
  else if (allZero) outcome = "UNWOUND";
  else inconsistency = unresolved ? "UNRESOLVED" : duplicates > 0 ? "DUPLICATE" : "ORPHAN";

  const orphanValue =
    outcome === "INCONSISTENT"
      ? orders.filter((o) => o.status === "CONFIRMED" || o.status === "PENDING").reduce((sum, o) => sum + o.price.amount_minor, 0)
      : 0;

  return {
    trip_id: trip.trip_id,
    arm: report.arm,
    outcome,
    inconsistency,
    duplicate_orders: duplicates,
    orphan_value_minor: orphanValue,
    belief_mismatches: components.filter((c) => !c.belief_matches && c.arm_belief !== "UNKNOWN").length,
    belief_unknowns: components.filter((c) => c.arm_belief === "UNKNOWN").length,
    arm_verdict: report.verdict,
    components,
  };
}
