import type { SimScenario, TripIntent } from "./types";

export interface ScenarioPreset {
  id: string;
  title: string;
  /** What the seeded supplier does, in plain words. */
  setup: string;
  /** What Intyr is expected to do. The run is judged by the server's recorded outcome, not by this text. */
  expect: string;
  faults: Array<{ component_index: number; fault: SimScenario }>;
}

/** Legs are listed hotel, transfer, flight. Intyr decides the commit order itself. */
export const SCENARIOS: ScenarioPreset[] = [
  {
    id: "flight-fails",
    title: "The flight fails after the hotel is booked",
    setup: "The hotel and the transfer confirm. The airline then rejects the booking.",
    expect: "Intyr stops, cancels the hotel and the transfer inside their free cancellation windows, and records what it cancelled.",
    faults: [{ component_index: 2, fault: "COMMIT_REJECT" }],
  },
  {
    id: "timeout-booked",
    title: "The airline times out but did book",
    setup: "The flight booking request times out. The airline did create the booking.",
    expect: "Intyr marks the flight unknown, does not retry, reads the airline record and then marks it confirmed.",
    faults: [{ component_index: 2, fault: "TIMEOUT_BOOKED" }],
  },
  {
    id: "timeout-not-booked",
    title: "The airline times out and did not book",
    setup: "The flight booking request times out. No booking exists at the airline.",
    expect: "Intyr marks the flight unknown, confirms through a read that nothing was booked, and unwinds the other legs.",
    faults: [{ component_index: 2, fault: "TIMEOUT_NOT_BOOKED" }],
  },
  {
    id: "status-disagrees",
    title: "The supplier says yes but its record says no",
    setup: "The hotel replies that the booking succeeded, but reading the booking back shows it does not exist.",
    expect: "Intyr does not trust the reply. The hotel is not marked confirmed and the trip recovers.",
    faults: [{ component_index: 0, fault: "RESPONSE_OK_STATUS_DISAGREES" }],
  },
  {
    id: "price-moves",
    title: "A price moves before commit",
    setup: "The hotel price changes between preparation and commit.",
    expect: "Intyr refuses to book at the new price without a recheck and an approval.",
    faults: [{ component_index: 0, fault: "PRICE_DIVERGENCE" }],
  },
  {
    id: "control",
    title: "Healthy control run",
    setup: "Every simulated supplier behaves normally.",
    expect: "Intyr commits all three legs without pausing or refusing.",
    faults: [
      { component_index: 0, fault: "HAPPY" },
      { component_index: 1, fault: "HAPPY" },
      { component_index: 2, fault: "HAPPY" },
    ],
  },
];

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/** A fresh seed per run. The simulator keeps state per seed, so two visitors on one seed would overwrite each other's offers. */
export function freshSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] ?? 1) % 2 ** 31;
}

/** Builds the prepare request for a preset. The faults come from the preset, the seed only isolates the run. */
export function scenarioIntent(preset: ScenarioPreset, seed: number = freshSeed()): TripIntent {
  const depart = isoDate(21);
  const checkout = isoDate(24);
  return {
    trip_ref: `demo-${preset.id}`,
    currency: "USD",
    budget_total_minor: 250_000,
    components: [
      { type: "HOTEL", city: "London", check_in: depart, check_out: checkout, guests: 1 },
      { type: "GROUND", from: "LHR", to: "Central London", pickup_at: `${depart}T18:00:00Z`, passengers: 1 },
      { type: "FLIGHT", origin: "JFK", destination: "LHR", depart_date: depart, passengers: 1 },
    ],
    limits: { max_total_minor: 250_000, max_price_move_pct: 2 },
    scenario: { seed, faults: preset.faults },
  };
}
