import type {
  ComponentClocks,
  ComponentState,
  EvidenceGrade,
  EvidenceTier,
  GateDecision,
  LegClass,
  Money,
  NextAction,
  OutcomeVerification,
  PreparationMode,
  Trip,
  TripComponent,
  TripState,
  TripSummary,
} from "./types";

/*
 * Wire shapes of the trip document served by apps/api (domain/trip-doc.ts, schema "trip/1").
 * The UI renders the normalized `Trip` so components never depend on storage layout.
 */

export interface WireComponentSummary {
  component_id: string;
  type: string;
  supplier: string;
  leg_class: string;
  evidence_grade: string;
  preparation_mode: string;
  irreversible: boolean;
  price: Money;
}

export interface WirePreparedLeg {
  component_id: string;
  type: string;
  adapter_id: string;
  provider_id: string;
  leg_class: string;
  evidence_grade: string;
  supplier_environment?: string;
  preparation_mode: string;
  price: Money;
  clocks?: ComponentClocks;
  irreversible: boolean;
  /** Template-built plain text, safe to show. */
  summary?: string;
  /** Supplier-authored text: plain text only, never HTML. */
  untrusted_notes?: string[];
  prepared_at?: string;
  sim?: { scenario?: string } | null;
}

export interface WireTripComponent {
  component_id: string;
  state: string;
  summary: WireComponentSummary;
  leg: WirePreparedLeg | null;
  refs: { booking_reference?: string | null; booking_id?: string | null; hold_order_id?: string | null } | null;
  outcome_verification: OutcomeVerification | null;
  confirmation: { evidence_tier: string; read_at: string; supplier_status: string | null; response_hash: string | null } | null;
  cancellation: { outcome: string; refund_minor: number | null; fee_minor: number | null } | null;
}

export interface WireTrip {
  trip_id: string;
  state: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
  trip_ref?: string | null;
  currency?: string;
  budget_total_minor?: number | null;
  scenario?: { seed: number; faults: unknown[] } | null;
  components?: WireTripComponent[];
  commit_order?: string[];
  next_actions?: Array<{ action: string; allowed: boolean; reason?: string; recommended_before?: string }>;
  deadline?: string | null;
  manifest_id?: string | null;
  manifest_hash?: string | null;
  plan_id?: string | null;
  financial_closure?: "NONE" | "OPEN" | "CLOSED";
  approval_required?: boolean;
  stranded_spend_minor?: number;
  final_manifest_id?: string | null;
  anchor?: { state: string; txid: string | null; mode: string } | null;
  decisions?: GateDecision[];
}

export interface WireTripListItem {
  trip_id: string;
  state: string;
  created_at: string;
  total: Money;
  components: Array<{ component_id: string; type: string; state: string; preparation_mode: string; evidence_grade: string }>;
  next_action: { action: string; allowed: boolean; reason?: string; deadline: string | null } | null;
}

function isWireTrip(value: unknown): value is WireTrip {
  return typeof value === "object" && value !== null && "trip_id" in value && Array.isArray((value as WireTrip).components);
}

export function normalizeComponent(wire: WireTripComponent, index: number, commitOrder: string[], decisions: GateDecision[]): TripComponent {
  const s = wire.summary;
  const clocks = wire.leg?.clocks;
  const orderIndex = commitOrder.indexOf(wire.component_id);
  return {
    component_id: wire.component_id,
    type: s.type,
    state: wire.state as ComponentState,
    preparation_mode: s.preparation_mode as PreparationMode,
    evidence_grade: s.evidence_grade as EvidenceGrade,
    leg_class: s.leg_class as LegClass,
    supplier: s.supplier,
    label: wire.leg?.summary,
    price: s.price,
    commit_order: orderIndex >= 0 ? orderIndex + 1 : commitOrder.length > 0 ? undefined : index + 1,
    irreversible: s.irreversible,
    outcome_verification: wire.outcome_verification ?? undefined,
    supplier_reference: wire.refs?.booking_reference ?? wire.refs?.booking_id ?? undefined,
    evidence_tier: (wire.confirmation?.evidence_tier as EvidenceTier | undefined) ?? undefined,
    untrusted_notes: wire.leg?.untrusted_notes,
    decisions: decisions.filter((d) => d.subject?.component_id === wire.component_id),
    ...(clocks ?? {}),
  };
}

export function normalizeTrip(input: unknown): Trip {
  const wire = (typeof input === "object" && input !== null && "trip" in input ? (input as { trip: unknown }).trip : input) as unknown;
  if (!isWireTrip(wire)) {
    const partial = wire as Partial<WireTrip>;
    return { trip_id: partial.trip_id ?? "", state: (partial.state ?? "DRAFT") as TripState, components: [] };
  }
  const decisions = wire.decisions ?? [];
  const commitOrder = wire.commit_order ?? [];
  const components = (wire.components ?? []).map((c, i) => normalizeComponent(c, i, commitOrder, decisions));
  const currency = wire.currency ?? components[0]?.price?.currency ?? "USD";
  const sum = (list: TripComponent[]) => ({ amount_minor: list.reduce((acc, c) => acc + (c.price?.amount_minor ?? 0), 0), currency });
  const priced = components.filter((c) => c.price?.currency === currency);
  const quoted = priced.filter((c) => c.state !== "REPLACED");
  const live = priced.filter((c) => !["REPLACED", "CANCELLED", "COMMIT_FAILED", "UNAVAILABLE", "EXPIRED"].includes(c.state));
  const booked = priced.filter((c) => c.state === "CONFIRMED");
  const total = live.length ? sum(live) : quoted.length ? sum(quoted) : undefined;
  const nextActions: NextAction[] = (wire.next_actions ?? []).map((a) => ({
    action: a.action,
    allowed: a.allowed,
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.recommended_before ? { deadline: a.recommended_before } : {}),
  }));
  return {
    trip_id: wire.trip_id,
    state: wire.state as TripState,
    created_at: wire.created_at,
    updated_at: wire.updated_at,
    label: wire.trip_ref ?? undefined,
    total,
    maximum_total: typeof wire.budget_total_minor === "number" ? { amount_minor: wire.budget_total_minor, currency } : undefined,
    components,
    manifest_id: wire.final_manifest_id ?? wire.manifest_id ?? (wire.state === "CHECKED" ? wire.plan_id : null) ?? undefined,
    manifest_hash: wire.manifest_hash ?? undefined,
    decisions,
    next_actions: nextActions,
    assurance: { mode: "NONE" },
    financial_closure: wire.financial_closure,
    approval: wire.approval_required ? { required: true, manifest_hash: wire.manifest_hash ?? undefined } : undefined,
    anchors: wire.anchor?.txid
      ? [{ txid: wire.anchor.txid, mode: wire.anchor.mode, confirmed: wire.anchor.state === "CONFIRMED" }]
      : undefined,
    anchor_state: wire.anchor?.state,
    quoted_total: quoted.length ? sum(quoted) : undefined,
    booked_total: booked.length ? sum(booked) : undefined,
    stranded_spend: typeof wire.stranded_spend_minor === "number" ? { amount_minor: wire.stranded_spend_minor, currency } : undefined,
    initial_manifest_id: wire.manifest_id ?? undefined,
    final_manifest_id: wire.final_manifest_id ?? undefined,
    plan_id: wire.plan_id ?? undefined,
    deadline: wire.deadline ?? undefined,
    scenario_seed: wire.scenario?.seed,
    version: wire.version,
  };
}

export function normalizeList(input: unknown): TripSummary[] {
  const items = Array.isArray(input)
    ? input
    : typeof input === "object" && input !== null
      ? ((input as { items?: unknown[]; trips?: unknown[] }).items ?? (input as { trips?: unknown[] }).trips ?? [])
      : [];
  return (items as WireTripListItem[]).map((item) => ({
    trip_id: item.trip_id,
    state: item.state as TripState,
    created_at: item.created_at,
    total: item.total,
    components: item.components.map((c) => ({
      component_id: c.component_id,
      type: c.type,
      state: c.state as ComponentState,
      preparation_mode: c.preparation_mode as PreparationMode,
      evidence_grade: c.evidence_grade as EvidenceGrade,
    })),
    next_action: item.next_action
      ? { action: item.next_action.action, allowed: item.next_action.allowed, ...(item.next_action.reason ? { reason: item.next_action.reason } : {}), ...(item.next_action.deadline ? { deadline: item.next_action.deadline } : {}) }
      : undefined,
  }));
}
