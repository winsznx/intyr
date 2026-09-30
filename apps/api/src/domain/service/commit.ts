import { SANDBOX_TRAVELER, type CommitResult, type IntyrAdapter, type PostconditionResult, type PreparedLeg } from "@intyr/adapters";
import {
  CommitRequestSchema,
  PUBLIC_DEFAULT_POLICY,
  canonicalize,
  componentStateAfterConfirm,
  decideCommit,
  nextCommitStep,
  decideComponentConfirm,
  hashValue,
  parseWith,
  sha256Hex,
  type CommitGateInput,
  type CommitRequest,
  type ComponentState,
  type GateDecision,
  type ParseResult,
  type TripState,
} from "@intyr/core";
import type { HandlerResult, PaidContext } from "../../payments/ladder";
import type { AttemptRow, ManifestRow, TripRow } from "../store";
import { VersionConflictError } from "../store";
import type { TripComponentDoc, TripDoc } from "../trip-doc";
import { DecisionLog, getTripOnNetwork, type ServiceDeps } from "./context";
import { finalizeManifest, performRecovery } from "./recover";
import { updateTripDoc } from "./trip-update";

export function parseCommit(body: unknown): ParseResult<CommitRequest> {
  return parseWith(CommitRequestSchema, body);
}

async function sha(value: unknown): Promise<string> {
  return hashValue(canonicalize(JSON.parse(JSON.stringify(value ?? null))));
}

/** Stable per (trip, component): sent to the supplier where it supports one, and used to look the booking up after a lost response. */
export async function idempotencyRefOf(tripId: string, componentId: string): Promise<string> {
  return `intyr-${(await sha256Hex(`${tripId}:${componentId}`)).slice(0, 24)}`;
}

export function httpForOutcome(outcome: GateDecision["outcome"]): number {
  switch (outcome) {
    case "ACT":
      return 200;
    case "NO_ACTION":
      return 200;
    case "MANUAL_REVIEW":
      return 202;
    case "UNKNOWN":
      return 503;
    case "REFUSE":
      return 422;
  }
}

async function gateInput(deps: ServiceDeps, row: TripRow, request: CommitRequest): Promise<CommitGateInput> {
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const requested = await deps.store.getManifest(request.manifest_id);
  const manifest = requested && requested.trip_id === row.id && requested.kind === "COMMIT" ? requested : null;
  const decisions = (await deps.store.listDecisions(row.id)) as GateDecision[];
  const prepared = [...decisions].reverse().find((d) => d.gate === "PREPARE");
  const approval = await deps.store.latestApproval(row.id);
  const signed = manifest ? (JSON.parse(manifest.signed_json) as { payload: { currency: string; total_minor: number } }) : null;
  return {
    trip: {
      trip_id: row.id,
      state: row.state as TripState,
      commit_manifest_hash: doc.commit_manifest_hash,
      component_states: doc.components.map((c) => c.state as ComponentState),
    },
    manifest:
      manifest && signed
        ? {
            manifest_id: manifest.id,
            manifest_hash: manifest.hash,
            status: manifest.status,
            expires_at: manifest.expires_at ?? new Date(0).toISOString(),
            currency: signed.payload.currency,
            total_minor: signed.payload.total_minor,
            prepare_decision: prepared ? { outcome: prepared.outcome, reason_codes: prepared.reason_codes } : { outcome: "ACT", reason_codes: ["ALL_CHECKS_PASSED"] },
          }
        : null,
    request,
    approval: approval && approval.decision === "APPROVE" ? { manifest_hash: approval.manifest_hash } : null,
    policy_version: prepared?.policy_version ?? PUBLIC_DEFAULT_POLICY.policy_version,
    now: deps.now(),
  };
}

/**
 * Runs before any charge. A foreseeable refusal, unknown or replay costs nothing. Returns null only
 * when the commit gate says ACT.
 */
export async function precheckCommit(body: unknown, deps: ServiceDeps): Promise<HandlerResult | null> {
  const parsed = parseCommit(body);
  if (!parsed.ok) return { status: 422, body: { error: "INVALID_REQUEST", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], issues: parsed.issues, charged: false } };
  const row = await getTripOnNetwork(deps, parsed.value.trip_id);
  if (!row) return { status: 404, body: { error: "NOT_FOUND", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"], charged: false } };
  const decision = await decideCommit(await gateInput(deps, row, parsed.value), await new DecisionLog(deps.store, row.id, deps.now).prevHash());
  if (decision.outcome === "ACT") return null;
  await new DecisionLog(deps.store, row.id, deps.now).append(decision);
  const doc = JSON.parse(row.doc_json) as TripDoc;
  return {
    status: httpForOutcome(decision.outcome),
    tripId: row.id,
    body: {
      trip_id: row.id,
      state: row.state,
      outcome: decision.outcome,
      decision_id: decision.decision_id,
      reason_codes: decision.reason_codes,
      next_actions: decision.next_actions,
      ...(decision.reconcile_by ? { reconcile_by: decision.reconcile_by, message: "Do not retry. Intyr is checking and will update this trip." } : {}),
      ...(decision.outcome === "NO_ACTION" ? { trip: { manifest_id: doc.manifest_id, final_manifest_id: doc.final_manifest_id, components: doc.components.map((c) => ({ component_id: c.component_id, state: c.state })) } } : {}),
      charged: false,
    },
  };
}

interface ComponentOutcome {
  state: ComponentState;
  decision: GateDecision;
  refs: PreparedLeg["refs"];
  confirmation: TripComponentDoc["confirmation"];
  attemptState: AttemptRow["state"];
}

/** Seconds a supplier may take to settle an answer before an unresolved component goes to an operator. */
function reconcileWindowSeconds(adapter: IntyrAdapter): number {
  return Math.max(3 * adapter.capabilities().visibility_lag_seconds, 300);
}

async function confirmComponent(
  deps: ServiceDeps,
  log: DecisionLog,
  tripId: string,
  leg: PreparedLeg,
  adapter: IntyrAdapter,
  write: CommitResult | null,
  refs: PreparedLeg["refs"],
  post: PostconditionResult | undefined,
  submittedAt: Date,
): Promise<ComponentOutcome> {
  const decision = await decideComponentConfirm(
    {
      trip_id: tripId,
      component_id: leg.component_id,
      write: write ? { response: write.response, no_booking_certain: write.no_booking_certain } : null,
      read: post ?? null,
      expected_price: leg.price,
      price_tolerance_minor: Math.round((leg.price.amount_minor * PUBLIC_DEFAULT_POLICY.max_price_move_pct) / 100),
      submitted_at: submittedAt,
      reconcile_window_seconds: reconcileWindowSeconds(adapter),
      policy_version: PUBLIC_DEFAULT_POLICY.policy_version,
      now: deps.now(),
    },
    await log.prevHash(),
  );
  await log.append(decision);
  const state = componentStateAfterConfirm(decision);
  const attemptState: AttemptRow["state"] = state === "CONFIRMED" ? "CONFIRMED" : state === "COMMIT_STATUS_UNKNOWN" ? "UNKNOWN" : "FAILED";
  const confirmation =
    state === "CONFIRMED" && post
      ? { evidence_tier: post.evidence_tier, read_at: post.read_at, supplier_status: post.supplier_status, response_hash: post.response_hash }
      : null;
  return { state, decision, refs: post ? { ...refs, ...post.refs } : refs, confirmation, attemptState };
}

/** A supplier call that throws is an unknown outcome, never a failure that invites a retry. */
function unknownCommitResult(now: Date, detail: string): CommitResult {
  return {
    response: "UNKNOWN",
    no_booking_certain: false,
    refs: { offer_id: null, hold_order_id: null, prebook_id: null, booking_id: null, booking_reference: null, passenger_ids: [] },
    price: null,
    supplier_status: null,
    error_code: "CALL_FAILED",
    detail,
    responded_at: now.toISOString(),
    response_hash: null,
  };
}

/**
 * Write-ahead commit of one component. The attempt row exists before the supplier is called, and an
 * existing attempt is never committed again: it goes to reconciliation by reference.
 */
async function commitOne(
  deps: ServiceDeps,
  log: DecisionLog,
  ctx: { tripId: string; operationId: string; request: CommitRequest; manifestHash: string },
  comp: TripComponentDoc,
): Promise<ComponentOutcome | null> {
  const leg = comp.leg!;
  const adapter = deps.adapters.get(leg.adapter_id);
  if (!adapter) return null;
  const now = deps.now();
  const idemRef = await idempotencyRefOf(ctx.tripId, comp.component_id);
  const { created, attempt } = await deps.store.startAttempt({
    trip_id: ctx.tripId,
    component_id: comp.component_id,
    action: "COMMIT",
    request_hash: await sha({ trip: ctx.tripId, component: comp.component_id, refs: leg.refs, price: leg.price, manifest: ctx.manifestHash }),
    idempotency_ref: idemRef,
    now: now.toISOString(),
  });

  if (!created) {
    if (attempt.state === "CONFIRMED") return null;
    // A prior attempt exists. Never call commit again. Read the supplier by our reference.
    let post: PostconditionResult | undefined;
    try {
      post = await adapter.reconcileByReference(leg, attempt.idempotency_ref);
    } catch {
      post = undefined;
    }
    const outcome = await confirmComponent(deps, log, ctx.tripId, leg, adapter, null, leg.refs, post, new Date(attempt.created_at));
    await deps.store.advanceAttempt(attempt.id, ["STARTED", "RESPONDED", "UNKNOWN"], outcome.attemptState, { detail: { reconciled: true } }, deps.now().toISOString());
    return outcome;
  }

  let result: CommitResult;
  try {
    result = await adapter.commit({
      leg,
      operation_id: ctx.operationId,
      idempotency_ref: idemRef,
      max_total: { amount_minor: ctx.request.maximum_total_minor, currency: ctx.request.currency },
      traveler: SANDBOX_TRAVELER,
    });
  } catch (e) {
    result = unknownCommitResult(deps.now(), e instanceof Error ? e.message : String(e));
  }
  await deps.store.advanceAttempt(attempt.id, ["STARTED"], "RESPONDED", { ...(result.response_hash ? { response_hash: result.response_hash } : {}), detail: { response: result.response, error_code: result.error_code } }, deps.now().toISOString());

  let post: PostconditionResult | undefined;
  if (result.response !== "REJECTED" || !result.no_booking_certain) {
    try {
      post = await adapter.postcondition(leg, result.refs);
    } catch {
      post = undefined;
    }
  }
  const outcome = await confirmComponent(deps, log, ctx.tripId, leg, adapter, result, result.refs, post, now);
  await deps.store.advanceAttempt(attempt.id, ["RESPONDED"], outcome.attemptState, {}, deps.now().toISOString());
  return outcome;
}

async function applyOutcome(deps: ServiceDeps, tripId: string, componentId: string, outcome: ComponentOutcome): Promise<void> {
  await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
    const c = d.components.find((x) => x.component_id === componentId);
    if (!c) return;
    c.state = outcome.state;
    c.refs = outcome.refs;
    if (outcome.confirmation) {
      c.confirmation = outcome.confirmation;
      c.outcome_verification = c.leg?.clocks.confirmation_mode === "INSTANT" ? "VERIFIED" : "PENDING_WINDOW";
    }
  });
}

/** Reads one unknown component by our own reference and lets the confirm gate decide. Nothing is committed again. */
async function reconcileComponent(deps: ServiceDeps, log: DecisionLog, tripId: string, comp: TripComponentDoc, createdAt: string): Promise<ComponentOutcome | null> {
  const leg = comp.leg;
  if (!leg) return null;
  const adapter = deps.adapters.get(leg.adapter_id);
  if (!adapter) return null;
  const idemRef = await idempotencyRefOf(tripId, comp.component_id);
  let post: PostconditionResult | undefined;
  try {
    post = await adapter.reconcileByReference(leg, idemRef);
  } catch {
    post = undefined;
  }
  const outcome = await confirmComponent(deps, log, tripId, leg, adapter, null, comp.refs ?? leg.refs, post, new Date(createdAt));
  const attempt = (await deps.store.listAttempts(tripId)).find((a) => a.component_id === comp.component_id && a.action === "COMMIT");
  if (attempt && outcome.state !== "COMMIT_STATUS_UNKNOWN") {
    await deps.store.advanceAttempt(attempt.id, ["STARTED", "RESPONDED", "UNKNOWN"], outcome.attemptState, { detail: { reconciled: true } }, deps.now().toISOString());
  }
  return outcome;
}

export interface DriveOptions {
  operationId: string;
  session: Parameters<typeof finalizeManifest>[3];
}

/**
 * Drives a commit forward from wherever it stands, using the pure next-step rule: submit the next prepared leg,
 * reconcile an unsettled one before anything else moves, or stop. Used by the paid commit and by the reconciler,
 * so a commit that paused on an unknown outcome resumes from that leg and never rewrites what already happened.
 */
export async function driveCommit(deps: ServiceDeps, tripId: string, opts: DriveOptions): Promise<{ state: TripState; manifestId: string | null }> {
  const first = JSON.parse((await deps.store.getTrip(tripId))!.doc_json) as TripDoc;
  const commit = first.commit;
  if (!commit) throw new Error(`trip ${tripId} has no commit in progress`);
  const log = new DecisionLog(deps.store, tripId, deps.now);
  const request = { trip_id: tripId, manifest_id: commit.manifest_id, manifest_hash: commit.manifest_hash, maximum_total_minor: commit.maximum_total_minor, currency: commit.currency, recovery_policy_acknowledged: true as const };
  for (let guard = 0; guard < 4 * first.commit_order.length + 4; guard++) {
    const row = (await deps.store.getTrip(tripId))!;
    const doc = JSON.parse(row.doc_json) as TripDoc;
    const step = nextCommitStep(doc.commit_order, doc.components.map((c) => ({ component_id: c.component_id, state: c.state as ComponentState, required: true })));
    if (step.kind === "SUBMIT") {
      const comp = doc.components.find((c) => c.component_id === step.component_id);
      if (!comp?.leg) break;
      const outcome = await commitOne(deps, log, { tripId, operationId: opts.operationId, request, manifestHash: commit.manifest_hash }, comp);
      if (!outcome) break;
      await applyOutcome(deps, tripId, step.component_id, outcome);
      if (outcome.state !== "CONFIRMED") break;
      continue;
    }
    if (step.kind === "RECONCILE") {
      const comp = doc.components.find((c) => c.component_id === step.component_id);
      if (!comp) break;
      const outcome = await reconcileComponent(deps, log, tripId, comp, row.updated_at);
      if (!outcome || outcome.state === "COMMIT_STATUS_UNKNOWN") break;
      await applyOutcome(deps, tripId, step.component_id, outcome);
      if (outcome.state !== "CONFIRMED") break;
      continue;
    }
    break;
  }
  return settleTrip(deps, tripId, opts.session);
}

/** Ends a commit pass: COMMITTED when every leg is confirmed, unknown while any leg is unsettled, otherwise unwind. */
export async function settleTrip(deps: ServiceDeps, tripId: string, session: Parameters<typeof finalizeManifest>[3]): Promise<{ state: TripState; manifestId: string | null }> {
  const row = (await deps.store.getTrip(tripId))!;
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const step = nextCommitStep(doc.commit_order, doc.components.map((c) => ({ component_id: c.component_id, state: c.state as ComponentState, required: true })));
  if (step.kind === "COMPLETE") {
    const pending = doc.components.some((c) => c.outcome_verification === "PENDING_WINDOW");
    const state: TripState = pending ? "COMMITTED_UNVERIFIED" : "COMMITTED";
    await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
      d.next_actions = [{ action: "VERIFY", allowed: true }];
      d.financial_closure = "CLOSED";
      return { state };
    });
    const fin = await finalizeManifest(deps, tripId, state, session);
    return { state, manifestId: fin.manifestId };
  }
  if (step.kind === "RECOVER") {
    await updateTripDoc(deps.store, tripId, deps.now().toISOString(), () => ({ state: "RECOVERING" }));
    const rec = await performRecovery(deps, tripId, { allowReplacement: false, headroomMinor: 0 });
    if (rec.finalState === "COMMIT_STATUS_UNKNOWN") return { state: rec.finalState, manifestId: null };
    const fin = await finalizeManifest(deps, tripId, rec.finalState, session);
    return { state: rec.finalState, manifestId: fin.manifestId };
  }
  // RECONCILE or HALT: something is unsettled. Wait for reconciliation and never start another write.
  await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
    d.next_actions = [{ action: "POLL", allowed: true }];
    return { state: "COMMIT_STATUS_UNKNOWN" };
  });
  return { state: "COMMIT_STATUS_UNKNOWN", manifestId: null };
}

/** Paid commit. Runs after settlement, re-runs the gate against current state, then the saga. */
export async function runCommit(body: unknown, ctx: PaidContext, deps: ServiceDeps): Promise<HandlerResult> {
  const parsed = parseCommit(body);
  if (!parsed.ok) return { status: 422, body: { error: "INVALID_REQUEST", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], issues: parsed.issues } };
  const request = parsed.value;
  const row = await getTripOnNetwork(deps, request.trip_id);
  if (!row) return { status: 404, body: { error: "NOT_FOUND", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"] } };
  const log = new DecisionLog(deps.store, row.id, deps.now);
  const gate = await decideCommit(await gateInput(deps, row, request), await log.prevHash());
  await log.append(gate);
  if (gate.outcome !== "ACT") {
    // The state changed between the pre-charge check and now. The fee is refunded by the refund record.
    return {
      status: httpForOutcome(gate.outcome),
      tripId: row.id,
      body: { trip_id: row.id, state: row.state, outcome: gate.outcome, decision_id: gate.decision_id, reason_codes: gate.reason_codes, next_actions: gate.next_actions, no_supplier_call_made: true },
      // A replay of a commit that already started or finished is delivered work, so its fee is kept.
      ...(gate.outcome === "NO_ACTION" ? {} : { feeFailure: "COMMIT_NOT_EXECUTED" as const }),
    };
  }

  // One runner per trip: the compare-and-set on the version decides who proceeds.
  const startedDoc = JSON.parse(row.doc_json) as TripDoc;
  startedDoc.commit_manifest_hash = request.manifest_hash;
  startedDoc.commit = { operation_id: ctx.operationId, manifest_id: request.manifest_id, manifest_hash: request.manifest_hash, maximum_total_minor: request.maximum_total_minor, currency: request.currency };
  try {
    await deps.store.updateTrip(row.id, row.version, { state: "COMMITTING", doc: startedDoc }, deps.now().toISOString());
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return { status: 200, tripId: row.id, body: { trip_id: row.id, outcome: "NO_ACTION", reason_codes: ["COMMIT_ALREADY_STARTED"], next_actions: [{ action: "POLL", allowed: true }] } };
    }
    throw e;
  }
  const settled = await driveCommit(deps, row.id, { operationId: ctx.operationId, session: ctx.session });
  const finalRow = (await deps.store.getTrip(row.id))!;
  const finalDoc = JSON.parse(finalRow.doc_json) as TripDoc;
  const unknown = settled.state === "COMMIT_STATUS_UNKNOWN";
  return {
    status: unknown ? 202 : 200,
    tripId: row.id,
    body: {
      trip_id: row.id,
      state: settled.state,
      ...(unknown
        ? { outcome: "UNKNOWN", reason_codes: ["COMPONENT_STATUS_UNKNOWN"], message: "We have not confirmed whether the supplier completed this. Do not retry. Intyr is checking and will update this trip.", supplier_action_may_have_occurred: true }
        : { outcome: settled.state === "COMMITTED" || settled.state === "COMMITTED_UNVERIFIED" ? "ACT" : "NO_ACTION" }),
      components: finalDoc.components.map((c) => ({ component_id: c.component_id, state: c.state, evidence_grade: c.summary.evidence_grade })),
      stranded_spend_minor: finalDoc.stranded_spend_minor,
      transaction_manifest_id: settled.manifestId,
      next_actions: finalDoc.next_actions,
    },
  };
}

/**
 * Cron reconciler. For every trip stuck in COMMIT_STATUS_UNKNOWN, resume the commit: the next-step rule reads the
 * unsettled component by our own reference first, and only continues forward once the gate has settled it.
 */
/** A live commit touches its trip far more often than this, so a trip idle this long in COMMITTING has no runner. */
const STUCK_COMMIT_MS = 5 * 60_000;

export async function reconcileUnknownTrips(deps: ServiceDeps, session: (tripId: string) => Promise<Parameters<typeof finalizeManifest>[3] | null>): Promise<number> {
  const stuckBefore = deps.now().getTime() - STUCK_COMMIT_MS;
  const rows = [
    ...(await deps.store.listTripsByState(["COMMIT_STATUS_UNKNOWN"], 20)),
    // A commit whose invocation died mid-saga stays COMMITTING. After the lease the reconciler resumes it the same way.
    ...(await deps.store.listTripsByState(["COMMITTING"], 20)).filter((r) => Date.parse(r.updated_at) <= stuckBefore),
  ];
  let resolved = 0;
  for (const row of rows) {
    const doc = JSON.parse(row.doc_json) as TripDoc;
    if (!doc.commit) continue;
    const s = await session(row.id);
    // Only sponsored sandbox commits, which exist on TestNet alone, have no payment session. A Mainnet commit always has one.
    if (!s && deps.environment === "MAINNET") continue;
    const before = row.state;
    const after = await driveCommit(deps, row.id, { operationId: doc.commit.operation_id, session: s });
    if (after.state !== before) resolved++;
  }
  return resolved;
}
