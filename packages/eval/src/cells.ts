import type { ComponentRequest, ComponentType, SimScenario } from "@intyr/adapters";

import type { TripSpec } from "./types";

/**
 * Pre-registered fault matrix. Each cell fixes which component misbehaves and
 * how, before any arm runs. Faults are simulator scenarios modelled on
 * documented supplier behaviour (Duffel test routes, LiteAPI error codes).
 */

export interface FaultCell {
  id: string;
  title: string;
  /** Scenario per component type; types not listed behave normally. */
  faults: Partial<Record<ComponentType, SimScenario>>;
  /** True when a correct agent can still complete the trip. */
  feasible: boolean;
}

export const CELLS: FaultCell[] = [
  { id: "C0", title: "Healthy control, no faults", faults: {}, feasible: true },
  { id: "F1", title: "Flight reprices between quote and payment", faults: { FLIGHT: "PRICE_DIVERGENCE" }, feasible: true },
  { id: "F2", title: "Flight inventory gone at commit", faults: { FLIGHT: "UNAVAILABLE_AT_COMMIT" }, feasible: false },
  { id: "F3", title: "Hotel refuses the booking after the flight confirmed", faults: { HOTEL: "COMMIT_REJECT" }, feasible: false },
  { id: "F4", title: "Flight accepted asynchronously, then fails", faults: { FLIGHT: "ACCEPTED_ASYNC_FAILS" }, feasible: false },
  { id: "F5", title: "Flight booked but the response is lost", faults: { FLIGHT: "TIMEOUT_BOOKED" }, feasible: true },
  { id: "F6", title: "Hotel times out and nothing was booked", faults: { HOTEL: "TIMEOUT_NOT_BOOKED" }, feasible: false },
  { id: "F7", title: "Hotel says confirmed but no booking exists", faults: { HOTEL: "RESPONSE_OK_STATUS_DISAGREES" }, feasible: false },
  { id: "F8", title: "Flight response lost, supplier duplicates on retry", faults: { FLIGHT: "DUPLICATE_ON_RETRY" }, feasible: true },
  { id: "F9", title: "Non-refundable flight, hotel refuses", faults: { FLIGHT: "NON_REFUNDABLE", HOTEL: "COMMIT_REJECT" }, feasible: false },
  { id: "F10", title: "Hotel cannot be cancelled, flight refuses", faults: { HOTEL: "CANCEL_REFUSED", FLIGHT: "COMMIT_REJECT" }, feasible: false },
];

export interface TripShape {
  id: string;
  types: ComponentType[];
}

/** Request order is the order a caller would naturally list the components. */
export const SHAPES: TripShape[] = [
  { id: "S1", types: ["FLIGHT", "HOTEL"] },
  { id: "S2", types: ["FLIGHT", "HOTEL", "GROUND"] },
];

function component(type: ComponentType, index: number, scenario: SimScenario, seed: string): ComponentRequest {
  const id = `cmp_${index + 1}_${type.toLowerCase()}`;
  const sim = { scenario, seed };
  switch (type) {
    case "FLIGHT":
      return { component_id: id, type, origin: "LHR", destination: "JFK", depart_date: "2026-11-12", adults: 1, currency: "USD", sim };
    case "HOTEL":
      return { component_id: id, type, check_in: "2026-11-12", check_out: "2026-11-15", adults: 1, currency: "USD", sim };
    case "GROUND":
      return { component_id: id, type, origin: "JFK", destination: "Midtown Manhattan", depart_date: "2026-11-12", adults: 1, currency: "USD", sim };
  }
}

export function tripFor(cell: FaultCell, shape: TripShape, repeat: number, campaign: string): TripSpec {
  const seed = `${campaign}:${cell.id}:${shape.id}:${repeat}`;
  return {
    trip_id: `trp_${campaign}_${cell.id}_${shape.id}_${repeat}`,
    seed,
    components: shape.types.map((t, i) => component(t, i, cell.faults[t] ?? "HAPPY", seed)),
    // Generous cap: faults, not budgets, decide outcomes in this campaign.
    max_total_minor: 150_000,
    currency: "USD",
  };
}
