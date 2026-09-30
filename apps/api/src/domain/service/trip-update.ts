import type { TripRow, TripStore } from "../store";
import { VersionConflictError } from "../store";
import type { TripDoc } from "../trip-doc";

export interface TripPatch {
  state?: string;
  total_minor?: number;
  readiness?: number;
}

/**
 * Loads a trip, lets `mutate` change its document, and writes it back with a compare-and-set on the
 * version. A stale worker's write fails and is retried against the newer state, never overwriting it.
 */
export async function updateTripDoc(
  store: TripStore,
  tripId: string,
  now: string,
  mutate: (doc: TripDoc, row: TripRow) => TripPatch | void,
  retries = 4,
): Promise<{ row: TripRow; doc: TripDoc }> {
  for (let attempt = 0; ; attempt++) {
    const row = await store.getTrip(tripId);
    if (!row) throw new Error(`trip ${tripId} not found`);
    const doc = JSON.parse(row.doc_json) as TripDoc;
    const patch = mutate(doc, row) ?? {};
    try {
      const updated = await store.updateTrip(tripId, row.version, { ...patch, doc }, now);
      return { row: updated, doc };
    } catch (e) {
      if (!(e instanceof VersionConflictError) || attempt >= retries) throw e;
    }
  }
}
