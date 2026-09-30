import type { PreparedLeg } from "@intyr/adapters";

export interface ComponentSummary {
  component_id: string;
  type: string;
  supplier: string;
  leg_class: string;
  evidence_grade: string;
  preparation_mode: string;
  irreversible: boolean;
  price: { amount_minor: number; currency: string };
}

export interface TripComponentDoc {
  component_id: string;
  state: string;
  summary: ComponentSummary;
  /** Null for legs a caller described itself in a check. Adapter legs carry the full prepared leg. */
  leg: PreparedLeg | null;
  /** Supplier references learned at commit time. */
  refs: PreparedLeg["refs"] | null;
  outcome_verification: "PENDING_WINDOW" | "VERIFIED" | "CONTRADICTED" | "TIMEOUT" | null;
  confirmation: { evidence_tier: string; read_at: string; supplier_status: string | null; response_hash: string | null } | null;
  cancellation: { outcome: string; refund_minor: number | null; fee_minor: number | null } | null;
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
  budget_total_minor: number | null;
  scenario: { seed: number; faults: unknown[] } | null;
  /** The prepared intent and its hash, kept so a revalidation can rebuild the manifest from the same request. */
  intent: unknown | null;
  intent_hash: string | null;
  components: TripComponentDoc[];
  commit_order: string[];
  next_actions: TripNextAction[];
  deadline: string | null;
  manifest_id: string | null;
  manifest_hash: string | null;
  plan_id: string | null;
  /** Hash of the manifest a commit started under. Set once, when the commit begins. */
  commit_manifest_hash: string | null;
  /** What a resumed commit needs: set once when the commit starts, so a reconciler can continue it. */
  commit: { operation_id: string; manifest_id: string; manifest_hash: string; maximum_total_minor: number; currency: string } | null;
  financial_closure: "NONE" | "OPEN" | "CLOSED";
  approval_required: boolean;
  stranded_spend_minor: number;
  final_manifest_id: string | null;
  anchor: { state: string; txid: string | null; mode: string } | null;
}

export interface TripListItem {
  trip_id: string;
  state: string;
  created_at: string;
  total: { amount_minor: number; currency: string };
  components: Array<{ component_id: string; type: string; state: string; preparation_mode: string; evidence_grade: string }>;
  next_action: { action: string; allowed: boolean; reason?: string; deadline: string | null } | null;
}

export function emptyTripDoc(currency: string): TripDoc {
  return {
    schema_version: "trip/1",
    trip_ref: null,
    currency,
    budget_total_minor: null,
    scenario: null,
    intent: null,
    intent_hash: null,
    components: [],
    commit_order: [],
    next_actions: [],
    deadline: null,
    manifest_id: null,
    manifest_hash: null,
    plan_id: null,
    commit_manifest_hash: null,
    commit: null,
    financial_closure: "NONE",
    approval_required: false,
    stranded_spend_minor: 0,
    final_manifest_id: null,
    anchor: null,
  };
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
      type: c.summary.type,
      state: c.state,
      preparation_mode: c.summary.preparation_mode,
      evidence_grade: c.summary.evidence_grade,
    })),
    next_action: allowed ? { action: allowed.action, allowed: allowed.allowed, ...(allowed.reason ? { reason: allowed.reason } : {}), deadline: allowed.recommended_before ?? doc.deadline } : null,
  };
}
