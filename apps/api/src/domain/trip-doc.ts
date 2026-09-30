import type { PreparedLeg } from "@intyr/adapters";

export interface TripComponentDoc {
  component_id: string;
  type: string;
  state: string;
  leg: PreparedLeg;
  outcome_verification: "PENDING_WINDOW" | "VERIFIED" | "CONTRADICTED" | "TIMEOUT" | null;
  confirmation: { evidence_tier: string; read_at: string; supplier_status: string | null; response_hash: string | null } | null;
}

export interface TripNextAction {
  action: string;
  allowed: boolean;
  reason?: string;
  recommended_before?: string;
}

/** The typed body of a trip row. Everything the UI and the agent API show about a trip derives from this. */
export interface TripDoc {
  schema_version: "trip/1";
  trip_ref: string | null;
  currency: string;
  budget_total_minor: number;
  scenario: { seed: number; faults: unknown[] } | null;
  components: TripComponentDoc[];
  commit_order: string[];
  next_actions: TripNextAction[];
  deadline: string | null;
  manifest_id: string | null;
  manifest_hash: string | null;
  financial_closure: "NONE" | "OPEN" | "CLOSED";
  approval_required: boolean;
}

export interface TripListItem {
  trip_id: string;
  state: string;
  created_at: string;
  total: { amount_minor: number; currency: string };
  components: Array<{ component_id: string; type: string; state: string; preparation_mode: string; evidence_grade: string }>;
  next_action: { action: string; allowed: boolean; reason?: string; deadline: string | null } | null;
}

export function toListItem(row: { id: string; state: string; created_at: string; currency: string | null; total_minor: number | null; doc_json: string }): TripListItem {
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const allowed = doc.next_actions.find((a) => a.allowed) ?? doc.next_actions[0] ?? null;
  return {
    trip_id: row.id,
    state: row.state,
    created_at: row.created_at,
    total: { amount_minor: row.total_minor ?? 0, currency: row.currency ?? doc.currency },
    components: doc.components.map((c) => ({
      component_id: c.component_id,
      type: c.type,
      state: c.state,
      preparation_mode: c.leg.preparation_mode,
      evidence_grade: c.leg.evidence_grade,
    })),
    next_action: allowed ? { action: allowed.action, allowed: allowed.allowed, ...(allowed.reason ? { reason: allowed.reason } : {}), deadline: allowed.recommended_before ?? doc.deadline } : null,
  };
}
