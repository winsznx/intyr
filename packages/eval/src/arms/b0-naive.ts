import type { CommitResult, PreparedLeg } from "@intyr/adapters";

import type { Arm, ComponentBelief } from "../types";

/**
 * B0: the naive sequential agent. It books components in the order asked,
 * retries a commit once when the response is unclear, never reads status and
 * never cancels. It is a floor, not the comparison that matters (that is B1).
 */
export const runB0: Arm = async (trip, deps) => {
  const beliefs: ComponentBelief[] = [];
  const notes: string[] = [];

  for (const req of trip.components) {
    const adapter = deps.adapterFor(req);
    const prep = await adapter.prepare(req);
    if (!prep.ok) {
      notes.push(`${req.component_id}: prepare failed (${prep.reason}), stopping`);
      beliefs.push({ component_id: req.component_id, belief: "NOT_BOOKED", booking_ids: [] });
      break;
    }
    const leg: PreparedLeg = prep.leg;
    const commit = (): Promise<CommitResult> =>
      adapter.commit({
        leg,
        operation_id: `${trip.trip_id}:b0`,
        idempotency_ref: `${trip.trip_id}:${req.component_id}`,
        max_total: { amount_minor: trip.max_total_minor, currency: trip.currency },
        traveler: deps.traveler,
      });
    let res = await commit();
    if (res.response === "UNKNOWN") {
      notes.push(`${req.component_id}: unclear response, retrying once`);
      res = await commit();
    }
    const bookingIds = res.refs.booking_id ? [res.refs.booking_id] : [];
    if (res.response === "RESPONDED_CONFIRMED" || res.response === "RESPONDED_ACCEPTED") {
      beliefs.push({ component_id: req.component_id, belief: "BOOKED", booking_ids: bookingIds });
      continue;
    }
    beliefs.push({ component_id: req.component_id, belief: res.response === "REJECTED" ? "NOT_BOOKED" : "UNKNOWN", booking_ids: bookingIds });
    notes.push(`${req.component_id}: ${res.response} (${res.error_code ?? "no code"}), stopping`);
    break;
  }

  const booked = beliefs.filter((b) => b.belief === "BOOKED").length;
  const verdict =
    booked === trip.components.length ? "COMPLETE" : beliefs.some((b) => b.belief === "UNKNOWN") ? "UNKNOWN" : booked === 0 ? "ABORTED" : "PARTIAL";
  return { arm: "B0", trip_id: trip.trip_id, verdict, components: beliefs, notes };
};
