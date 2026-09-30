import type { ComponentRequest, IntyrAdapter, SandboxTraveler } from "@intyr/adapters";

/**
 * Contract between the campaign harness and every arm. An arm receives a trip
 * and a set of supplier adapters and reports what it believes happened. The
 * auditor then compares that belief with the supplier-side order list, which
 * no arm can write to directly.
 */

export interface TripSpec {
  /** Unique per run. Arms derive idempotency references from it. */
  trip_id: string;
  /** Simulator seed; every fault in the trip is fixed by it before the run. */
  seed: string;
  /** In the order the caller asked for them. Arms may reorder. */
  components: ComponentRequest[];
  /** Hard cap for the whole trip in minor units. */
  max_total_minor: number;
  currency: string;
}

export interface ArmDeps {
  adapterFor(req: ComponentRequest): IntyrAdapter;
  /** Waits. In-process runs advance a simulated clock instead of sleeping. */
  sleep(seconds: number): Promise<void>;
  now(): Date;
  traveler: SandboxTraveler;
  log(event: string, data?: unknown): void;
}

export type BeliefState = "BOOKED" | "NOT_BOOKED" | "CANCELLED" | "UNKNOWN";

export type ArmVerdict = "COMPLETE" | "UNWOUND" | "PARTIAL" | "UNKNOWN" | "ABORTED";

export interface ComponentBelief {
  component_id: string;
  belief: BeliefState;
  booking_ids: string[];
}

export interface ArmReport {
  arm: string;
  trip_id: string;
  /** What the arm believes the trip ended as. */
  verdict: ArmVerdict;
  components: ComponentBelief[];
  notes: string[];
}

export type Arm = (trip: TripSpec, deps: ArmDeps) => Promise<ArmReport>;
