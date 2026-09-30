import type { AdapterId, ComponentRequest, IntyrAdapter, PreparedLeg, SimScenario } from "@intyr/adapters";
import {
  CheckRequestSchema,
  PublicTripIntentSchema,
  RevalidateRequestSchema,
  buildCommitManifest,
  canonicalize,
  checkTrip,
  hashValue,
  merkleRoot,
  newId,
  parseWith,
  PUBLIC_DEFAULT_POLICY,
  decidePrepare,
  effectivePolicy,
  legFromPrepared,
  signCommitManifest,
  type Assessment,
  type CheckRequest,
  type GateDecision,
  type ParseResult,
  type PublicTripIntent,
  type TripState,
} from "@intyr/core";
import type { HandlerResult, PaidContext } from "../../payments/ladder";
import type { TripStore } from "../store";
import { emptyTripDoc, type TripComponentDoc, type TripDoc, type TripNextAction } from "../trip-doc";
import { DecisionLog, type ServiceDeps } from "./context";
import { paymentRefs, toManifestComponent } from "./convert";

export function invalid(issues: Array<{ path: string; message: string }>): HandlerResult {
  return {
    status: 422,
    body: { error: "INVALID_REQUEST", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], issues, charged: false },
  };
}

export function parseCheck(body: unknown): ParseResult<CheckRequest> {
  return parseWith(CheckRequestSchema, body);
}

export function parseIntent(body: unknown): ParseResult<PublicTripIntent> {
  return parseWith(PublicTripIntentSchema, body);
}

export function tripOwner(ctx: PaidContext, sessionId?: string): string {
  return sessionId ? `session:${sessionId}` : `payer:${ctx.session?.payer ?? "unknown"}`;
}

function summarize(leg: PreparedLeg): TripComponentDoc["summary"] {
  return {
    component_id: leg.component_id,
    type: leg.type,
    supplier: leg.provider_id,
    leg_class: leg.leg_class,
    evidence_grade: leg.evidence_grade,
    preparation_mode: leg.preparation_mode,
    irreversible: leg.irreversible,
    price: leg.price,
  };
}

function nextActionsOf(decision: GateDecision): TripNextAction[] {
  return decision.next_actions.map((a) => ({
    action: a.action,
    allowed: a.allowed,
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.recommended_before ? { recommended_before: a.recommended_before } : {}),
  }));
}

/** POST /v1/trips/check. Caller-supplied legs in, a signed commit plan out. No supplier is called and nothing is booked. */
export async function runCheck(request: CheckRequest, ctx: PaidContext, deps: ServiceDeps, sessionId?: string): Promise<HandlerResult> {
  const now = deps.now();
  const signed = await checkTrip(request, { now, environment: deps.environment, key: deps.key });
  const plan = signed.payload;
  const doc = emptyTripDoc(request.currency);
  doc.trip_ref = request.trip_ref ?? null;
  doc.plan_id = plan.plan_id;
  doc.manifest_hash = signed.payload_hash;
  doc.deadline = plan.valid_until ?? null;
  doc.commit_order = plan.commit_order;
  doc.next_actions = nextActionsOf(plan.decision);
  doc.components = plan.commit_order.map((id) => {
    const leg = request.legs.find((l) => l.leg_id === id)!;
    const planned = plan.legs.find((l) => l.leg_id === id)!;
    return {
      component_id: id,
      state: "PREPARED",
      summary: {
        component_id: id,
        type: leg.type,
        supplier: leg.supplier,
        leg_class: "CALLER_SUPPLIED",
        evidence_grade: "CALLER_ASSERTED",
        preparation_mode: planned.hold_strength,
        irreversible: planned.irreversible,
        price: leg.price,
      },
      leg: null,
      refs: null,
      outcome_verification: null,
      confirmation: null,
      cancellation: null,
    };
  });
  const trip = await deps.store.createTrip({
    network: deps.environment.toLowerCase(),
    owner: tripOwner(ctx, sessionId),
    state: "CHECKED",
    currency: request.currency,
    total_minor: plan.exposure.total_minor,
    readiness: plan.readiness.score,
    doc,
    operation_id: ctx.operationId,
    now: now.toISOString(),
  });
  await deps.store.putManifest({
    id: plan.plan_id,
    trip_id: trip.id,
    kind: "PLAN",
    hash: signed.payload_hash,
    status: "ACTIVE",
    expires_at: plan.valid_until ?? null,
    network: deps.environment.toLowerCase(),
    signed_json: JSON.stringify(signed),
    now: now.toISOString(),
  });
  await new DecisionLog(deps.store, trip.id, deps.now).append(plan.decision);
  const anchor = await anchorBestEffort(deps, plan.plan_id, signed.payload_hash);
  return {
    status: 200,
    tripId: trip.id,
    body: {
      trip_id: trip.id,
      state: "CHECKED",
      plan_id: plan.plan_id,
      verdict: plan.verdict,
      decision: { outcome: plan.decision.outcome, reason_codes: plan.decision.reason_codes, decision_id: plan.decision.decision_id },
      next_actions: doc.next_actions,
      plan: signed,
      anchor,
    },
  };
}

async function anchorBestEffort(deps: ServiceDeps, manifestId: string, hash: string): Promise<{ state: string; txid: string | null; mode: string }> {
  if (!deps.anchor) return { state: "NOT_CONFIGURED", txid: null, mode: "UNANCHORED" };
  try {
    const ref = await deps.anchor(manifestId, hash);
    if (!ref) return { state: "NOT_CONFIGURED", txid: null, mode: "UNANCHORED" };
    return { state: ref.confirmed_round ? "CONFIRMED" : "PENDING", txid: ref.txid, mode: ref.mode };
  } catch {
    return { state: "PENDING", txid: null, mode: "SEPARATE_NOTE_TRANSACTION" };
  }
}

// ------------------------------------------------------------------ prepare

function componentIdOf(type: string, index: number): string {
  return `${type.toLowerCase()}-${index + 1}`;
}

/** The adapter each component type is prepared through. A seeded scenario always uses the simulator. */
function adapterFor(deps: ServiceDeps, type: "FLIGHT" | "HOTEL" | "GROUND", simulated: boolean): IntyrAdapter | undefined {
  return deps.adapters.forType(type, { simulated });
}

export type ComponentPlan = { request: ComponentRequest; adapter: IntyrAdapter };

export function buildComponentRequests(intent: PublicTripIntent, tripId: string, deps: ServiceDeps): { plans: ComponentPlan[]; unsupported: string[] } {
  const plans: ComponentPlan[] = [];
  const unsupported: string[] = [];
  const faultsByIndex = new Map<number, SimScenario>();
  for (const f of intent.scenario?.faults ?? []) faultsByIndex.set(f.component_index, f.fault as SimScenario);
  const seed = String(intent.scenario?.seed ?? tripId);
  const simulated = intent.scenario !== undefined;
  intent.components.forEach((c, index) => {
    const component_id = componentIdOf(c.type, index);
    if (c.type !== "FLIGHT" && c.type !== "HOTEL" && c.type !== "GROUND") {
      unsupported.push(component_id);
      return;
    }
    const adapter = adapterFor(deps, c.type, simulated);
    if (!adapter) {
      unsupported.push(component_id);
      return;
    }
    const base = { component_id, type: c.type, currency: intent.currency } as const;
    const sim = adapter.metadata().leg_class === "SIMULATED" ? { scenario: faultsByIndex.get(index) ?? ("HAPPY" as const), seed } : undefined;
    let request: ComponentRequest;
    if (c.type === "FLIGHT") {
      request = { ...base, origin: c.origin, destination: c.destination, depart_date: c.depart_date, adults: c.passengers, hold: c.hold_if_available };
    } else if (c.type === "HOTEL") {
      request = { ...base, destination: c.city ?? `${c.latitude ?? ""},${c.longitude ?? ""}`, check_in: c.check_in, check_out: c.check_out, adults: c.guests };
    } else {
      request = { ...base, origin: c.from, destination: c.to, depart_date: c.pickup_at.slice(0, 10), adults: c.passengers };
    }
    plans.push({ request: sim ? { ...request, sim } : request, adapter });
  });
  return { plans, unsupported };
}

export interface PrepareOutcome {
  legs: PreparedLeg[];
  failures: Array<{ component_id: string; reason: string; detail: string }>;
}

export async function prepareLegs(plans: ComponentPlan[]): Promise<PrepareOutcome> {
  const legs: PreparedLeg[] = [];
  const failures: PrepareOutcome["failures"] = [];
  const results = await Promise.all(
    plans.map(async (p) => {
      try {
        return { id: p.request.component_id, result: await p.adapter.prepare(p.request) };
      } catch (e) {
        return { id: p.request.component_id, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  for (const r of results) {
    if ("error" in r) failures.push({ component_id: r.id, reason: "SUPPLIER_ERROR", detail: r.error ?? "unknown" });
    else if (r.result.ok) legs.push(r.result.leg);
    else failures.push({ component_id: r.id, reason: r.result.reason, detail: r.result.detail });
  }
  return { legs, failures };
}

const MANIFEST_TTL_MS = 10 * 60_000;

export interface ManifestBuild {
  manifestId: string;
  hash: string;
  signedJson: string;
  expiresAt: string;
  assessment: Assessment;
  decision: GateDecision;
  state: TripState;
  nextActions: TripNextAction[];
  approvalRequired: boolean;
}

const VERDICT_OF_OUTCOME: Record<GateDecision["outcome"], string> = {
  ACT: "COMMIT_NOW",
  UNKNOWN: "REVALIDATE_FIRST",
  MANUAL_REVIEW: "NEEDS_APPROVAL",
  REFUSE: "DO_NOT_COMMIT",
  NO_ACTION: "DO_NOT_COMMIT",
};

/** Runs the PREPARE gate over prepared legs, then builds and signs the commit manifest. Shared by prepare and revalidate. */
export async function buildManifest(
  deps: ServiceDeps,
  input: { tripId: string; legs: PreparedLeg[]; intent: PublicTripIntent; intentHash: string; supersedes?: string; inbound: ReturnType<typeof paymentRefs>; decisionHashes: string[]; prevDecisionHash?: string },
): Promise<ManifestBuild> {
  const now = deps.now();
  const policy = effectivePolicy(PUBLIC_DEFAULT_POLICY, input.intent.limits, input.intent.budget_total_minor);
  const { assessment, decision } = await decidePrepare({
    trip_id: input.tripId,
    currency: input.intent.currency,
    legs: input.legs.map((l) => legFromPrepared(l)),
    policy,
    now,
    ...(input.prevDecisionHash ? { prev_decision_hash: input.prevDecisionHash } : {}),
  });
  const expiresAt = assessment.valid_until ?? new Date(now.getTime() + MANIFEST_TTL_MS).toISOString();
  const byId = new Map(input.legs.map((l) => [l.component_id, l]));
  const manifest = await buildCommitManifest({
    manifest_id: newId("man"),
    trip_id: input.tripId,
    environment: deps.environment,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    intent_hash: input.intentHash,
    currency: input.intent.currency,
    total_minor: assessment.exposure.total_minor,
    components: assessment.commit_order.map((id) => toManifestComponent(byId.get(id)!, "PREPARED")),
    commit_order: assessment.commit_order,
    readiness: assessment.readiness,
    exposure: assessment.exposure,
    decision_log_root: await merkleRoot([...input.decisionHashes, decision.decision_hash]),
    non_actions: [],
    recovery_policy: {
      policy_version: decision.policy_version,
      replacement_headroom_minor: 0,
      cancel_reversible_on_failure: true,
      never_replace_while_unknown: true,
    },
    assurance: { mode: "NONE" },
    inbound_payments: input.inbound,
  });
  const signed = await signCommitManifest(deps.key, manifest);
  const state: TripState = assessment.outcome === "ACT" ? "PREPARED" : "PREPARED_WITH_WARNINGS";
  return {
    manifestId: manifest.manifest_id,
    hash: signed.payload_hash,
    signedJson: JSON.stringify(signed),
    expiresAt,
    assessment,
    decision,
    state,
    nextActions: nextActionsOf(decision),
    approvalRequired: assessment.outcome === "MANUAL_REVIEW",
  };
}

/** POST /v1/trips/prepare. Intyr prepares each component through its adapter and returns a trip and a signed commit manifest. */
export async function runPrepare(intent: PublicTripIntent, ctx: PaidContext, deps: ServiceDeps, sessionId?: string): Promise<HandlerResult> {
  if (intent.scenario && !deps.allowScenario) {
    return { status: 422, body: { error: "SCENARIO_NOT_ALLOWED", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], message: "Seeded fault scenarios are accepted on the sandbox host only." } };
  }
  const now = deps.now();
  const tripId = newId("trp");
  const { plans, unsupported } = buildComponentRequests(intent, tripId, deps);
  const { legs, failures } = await prepareLegs(plans);
  const doc = emptyTripDoc(intent.currency);
  doc.trip_ref = intent.trip_ref ?? null;
  doc.budget_total_minor = intent.budget_total_minor;
  doc.scenario = intent.scenario ? { seed: intent.scenario.seed, faults: intent.scenario.faults } : null;
  doc.intent = JSON.parse(JSON.stringify(intent));
  const owner = tripOwner(ctx, sessionId);
  const allFailures = [...failures, ...unsupported.map((id) => ({ component_id: id, reason: "UNSUPPORTED", detail: "component type is not available in this release" }))];

  if (allFailures.length > 0 || legs.length === 0) {
    doc.next_actions = [{ action: "PREPARE", allowed: true }, { action: "COMMIT", allowed: false, reason: "COMPONENT_NOT_READY" }];
    doc.components = legs.map((l) => ({ component_id: l.component_id, state: "PREPARED", summary: summarize(l), leg: l, refs: null, outcome_verification: null, confirmation: null, cancellation: null }));
    const trip = await deps.store.createTrip({ id: tripId, network: deps.environment.toLowerCase(), owner, state: "PREPARATION_FAILED", currency: intent.currency, doc, operation_id: ctx.operationId, now: now.toISOString() });
    return {
      status: 200,
      tripId: trip.id,
      body: { trip_id: trip.id, state: "PREPARATION_FAILED", outcome: "REFUSE", reason_codes: ["COMPONENT_NOT_READY"], failures: allFailures, next_actions: doc.next_actions, no_booking_occurred: true },
    };
  }

  const intentHash = await hashValue(canonicalize(JSON.parse(JSON.stringify(intent))));
  doc.intent_hash = intentHash;
  const build = await buildManifest(deps, { tripId, legs, intent, intentHash, inbound: paymentRefs(ctx.session), decisionHashes: [] });
  doc.components = build.assessment.commit_order.map((id) => {
    const leg = legs.find((l) => l.component_id === id)!;
    return { component_id: id, state: "PREPARED", summary: summarize(leg), leg, refs: null, outcome_verification: null, confirmation: null, cancellation: null };
  });
  doc.commit_order = build.assessment.commit_order;
  doc.next_actions = build.nextActions;
  doc.deadline = build.expiresAt;
  doc.manifest_id = build.manifestId;
  doc.manifest_hash = build.hash;
  doc.plan_id = build.decision.decision_id;
  doc.approval_required = build.approvalRequired;
  const trip = await deps.store.createTrip({
    id: tripId,
    network: deps.environment.toLowerCase(),
    owner,
    state: build.state,
    currency: intent.currency,
    total_minor: build.assessment.exposure.total_minor,
    readiness: build.assessment.readiness.score,
    doc,
    operation_id: ctx.operationId,
    now: now.toISOString(),
  });
  await deps.store.putManifest({ id: build.manifestId, trip_id: tripId, kind: "COMMIT", hash: build.hash, status: "ACTIVE", expires_at: build.expiresAt, network: deps.environment.toLowerCase(), signed_json: build.signedJson, now: now.toISOString() });
  await new DecisionLog(deps.store, tripId, deps.now).append(build.decision);
  const anchor = await anchorBestEffort(deps, build.manifestId, build.hash);
  return {
    status: 200,
    tripId,
    body: {
      trip_id: tripId,
      state: build.state,
      manifest_id: build.manifestId,
      manifest_hash: build.hash,
      manifest_expires_at: build.expiresAt,
      verdict: VERDICT_OF_OUTCOME[build.decision.outcome],
      decision: { outcome: build.decision.outcome, reason_codes: build.decision.reason_codes, decision_id: build.decision.decision_id },
      readiness: build.assessment.readiness,
      exposure: build.assessment.exposure,
      next_actions: build.nextActions,
      evidence_banner: (JSON.parse(build.signedJson) as { payload: { evidence_banner: string } }).payload.evidence_banner,
      manifest: JSON.parse(build.signedJson),
      anchor,
    },
  };
}

// --------------------------------------------------------------- revalidate

export async function runRevalidate(body: unknown, ctx: PaidContext, deps: ServiceDeps): Promise<HandlerResult> {
  const parsed = parseWith(RevalidateRequestSchema, body);
  if (!parsed.ok) return invalid(parsed.issues);
  const row = await deps.store.getTrip(parsed.value.trip_id);
  if (!row) return { status: 404, body: { error: "NOT_FOUND", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"] } };
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const revalidatable = ["PREPARED", "PREPARED_WITH_WARNINGS", "READY_TO_COMMIT"];
  if (!revalidatable.includes(row.state)) {
    return { status: 409, tripId: row.id, body: { error: "TRIP_STATE_CONFLICT", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"], state: row.state } };
  }
  const now = deps.now();
  const changes: Array<{ component_id: string; status: string; previous_minor: number; current_minor: number }> = [];
  const legs: PreparedLeg[] = [];
  for (const comp of doc.components) {
    if (!comp.leg) continue;
    const adapter = deps.adapters.get(comp.leg.adapter_id);
    if (!adapter) continue;
    const r = await adapter.revalidate(comp.leg);
    legs.push(r.leg);
    changes.push({ component_id: comp.component_id, status: r.status, previous_minor: r.previous_price.amount_minor, current_minor: r.leg.price.amount_minor });
  }
  const material = changes.some((c) => c.status !== "UNCHANGED");
  if (!material) {
    return { status: 200, tripId: row.id, body: { trip_id: row.id, state: row.state, manifest_changed: false, manifest_id: doc.manifest_id, manifest_hash: doc.manifest_hash, changes } };
  }
  const stored = doc.intent && doc.intent_hash ? { intent: doc.intent as PublicTripIntent, intentHash: doc.intent_hash } : null;
  if (!stored) return { status: 409, tripId: row.id, body: { error: "TRIP_STATE_CONFLICT", outcome: "UNKNOWN", reason_codes: ["COMPONENT_STATUS_UNKNOWN"] } };
  const log = new DecisionLog(deps.store, row.id, deps.now);
  const prior = (await deps.store.listDecisions(row.id)) as GateDecision[];
  const build = await buildManifest(deps, {
    tripId: row.id,
    legs,
    intent: stored.intent,
    intentHash: stored.intentHash,
    ...(doc.manifest_id ? { supersedes: doc.manifest_id } : {}),
    inbound: paymentRefs(ctx.session),
    decisionHashes: prior.map((d) => d.decision_hash),
    ...(prior.length > 0 ? { prevDecisionHash: prior[prior.length - 1]!.decision_hash } : {}),
  });
  const previous = await deps.store.getActiveManifest(row.id);
  if (previous) await deps.store.setManifestStatus(previous.id, "SUPERSEDED", now.toISOString());
  await deps.store.putManifest({ id: build.manifestId, trip_id: row.id, kind: "COMMIT", hash: build.hash, status: "ACTIVE", expires_at: build.expiresAt, network: deps.environment.toLowerCase(), signed_json: build.signedJson, now: now.toISOString() });
  await log.append(build.decision);
  doc.components = doc.components.map((c) => {
    const leg = legs.find((l) => l.component_id === c.component_id);
    return leg ? { ...c, state: "PREPARED", leg, summary: summarize(leg) } : c;
  });
  doc.commit_order = build.assessment.commit_order;
  doc.next_actions = build.nextActions;
  doc.deadline = build.expiresAt;
  doc.manifest_id = build.manifestId;
  doc.manifest_hash = build.hash;
  doc.approval_required = build.approvalRequired;
  await deps.store.updateTrip(row.id, row.version, { state: build.state, total_minor: build.assessment.exposure.total_minor, readiness: build.assessment.readiness.score, doc }, now.toISOString());
  return {
    status: 200,
    tripId: row.id,
    body: {
      trip_id: row.id,
      state: build.state,
      manifest_changed: true,
      superseded_manifest_id: previous?.id ?? null,
      manifest_id: build.manifestId,
      manifest_hash: build.hash,
      manifest_expires_at: build.expiresAt,
      verdict: VERDICT_OF_OUTCOME[build.decision.outcome],
      changes,
      next_actions: build.nextActions,
      manifest: JSON.parse(build.signedJson),
    },
  };
}

export type { TripStore };
export type { AdapterId };
