import type { Trip } from "./types";

export interface ReceiptRecord {
  /** The record a reader should check: the final manifest once it exists, otherwise the commit manifest or the plan. */
  id: string;
  /** The hash of that same record. Absent when the trip document does not carry it, so a card never pairs two records. */
  hash?: string;
}

export function receiptRecord(trip: Trip): ReceiptRecord | undefined {
  if (trip.final_manifest_id) return { id: trip.final_manifest_id };
  if (trip.initial_manifest_id) return { id: trip.initial_manifest_id, ...(trip.manifest_hash ? { hash: trip.manifest_hash } : {}) };
  if (trip.manifest_id) return { id: trip.manifest_id };
  return undefined;
}
