import { CheckRequestSchema, type CheckRequest } from "../src/schema";
import type { ManifestComponent } from "../src/types";
import type { EvidenceGrade } from "../src/vocab";

export const NOW = new Date("2026-10-01T12:00:00.000Z");
export const TRIP_ID = "trp_000000000000000000000001";
export const HASH_A = "sha256:" + "a".repeat(64);
export const HASH_B = "sha256:" + "b".repeat(64);

export function inMinutes(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

/** Raw wire leg: refundable, free to cancel for a day, price valid for an hour, held firmly. */
export function wireLeg(leg_id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leg_id,
    type: "HOTEL",
    supplier: "liteapi",
    offer_ref: `offer_${leg_id}`,
    price: { amount_minor: 20_000, currency: "USD" },
    preparation_mode: "HARD_HOLD",
    refundable: true,
    clocks: { price_valid_until: inMinutes(60), free_cancel_until: inMinutes(24 * 60) },
    ...overrides,
  };
}

/** Raw wire leg that cannot be undone once committed. */
export function irreversibleWireLeg(leg_id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return wireLeg(leg_id, {
    type: "FLIGHT",
    supplier: "duffel",
    refundable: false,
    clocks: { price_valid_until: inMinutes(60) },
    ...overrides,
  });
}

export function checkRequest(legs: Record<string, unknown>[], limits: Record<string, unknown> = {}): CheckRequest {
  return CheckRequestSchema.parse({ currency: "USD", legs, limits });
}

export function manifestComponent(id: string, evidence_grade: EvidenceGrade = "SUPPLIER_SANDBOX"): ManifestComponent {
  return {
    component_id: id,
    leg_id: id,
    type: "FLIGHT",
    leg_class: "SUPPLIER_SANDBOX",
    adapter_id: "duffel-flights",
    adapter_version: "0.1.0",
    supplier: "duffel",
    preparation_mode: "INSTANT_COMMIT_ONLY",
    state: "PREPARED",
    price: { amount_minor: 20_000, currency: "USD" },
    clocks: {
      price_valid_until: inMinutes(30),
      inventory_held_until: null,
      free_cancel_until: null,
      void_until: null,
      refund_destination: "UNKNOWN",
      refund_amount_certainty: "UNKNOWN",
      confirmation_mode: "INSTANT",
      supplier_can_cancel: false,
    },
    irreversible: true,
    evidence_grade,
    supplier_mode: "TEST",
    synthetic_faults: [],
  };
}
