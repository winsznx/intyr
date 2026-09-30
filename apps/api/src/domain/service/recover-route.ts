import { RecoverRequestSchema, makeDecision, parseWith, type TripState } from "@intyr/core";
import type { HandlerResult, PaidContext } from "../../payments/ladder";
import type { TripDoc } from "../trip-doc";
import type { PaidActor } from "../../payments/ladder";
import { DecisionLog, NOT_TRIP_OWNER, actorOwnsTrip, getTripOnNetwork, type ServiceDeps } from "./context";
import { finalizeManifest, performRecovery, RECOVERY_POLICY_VERSION } from "./recover";
import { httpForOutcome } from "./commit";

const RECOVERABLE: TripState[] = ["RECOVERING", "COMMITTING"];

/** Free when there is nothing to recover or the state is unknown: a foreseeable non-action costs nothing. */
export async function precheckRecover(body: unknown, deps: ServiceDeps, actor: PaidActor): Promise<HandlerResult | null> {
  const parsed = parseWith(RecoverRequestSchema, body);
  if (!parsed.ok) return { status: 422, body: { error: "INVALID_REQUEST", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], issues: parsed.issues, charged: false } };
  const row = await getTripOnNetwork(deps, parsed.value.trip_id);
  if (!row) return { status: 404, body: { error: "NOT_FOUND", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"], charged: false } };
  if (!(await actorOwnsTrip(deps, row, actor))) return { ...NOT_TRIP_OWNER };
  const state = row.state as TripState;
  if (RECOVERABLE.includes(state)) return null;

  const log = new DecisionLog(deps.store, row.id, deps.now);
  const now = deps.now();
  const doc = JSON.parse(row.doc_json) as TripDoc;
  let decision;
  if (state === "COMMIT_STATUS_UNKNOWN") {
    decision = await makeDecision({
      gate: "RECOVERY_ACTION",
      subject: { trip_id: row.id },
      outcome: "UNKNOWN",
      reason_codes: ["COMPONENT_STATUS_UNKNOWN"],
      inputs: { state },
      policy_version: RECOVERY_POLICY_VERSION,
      next_actions: [{ action: "POLL", allowed: true }],
      reconcile_by: new Date(now.getTime() + 5 * 60_000).toISOString(),
      now,
      ...(await withPrev(log)),
    });
  } else {
    const done = state === "RECOVERED" || state === "COMMIT_NOT_EXECUTED" || state === "RECOVERY_FAILED";
    decision = await makeDecision({
      gate: "RECOVERY_ACTION",
      subject: { trip_id: row.id },
      outcome: "NO_ACTION",
      reason_codes: [done ? "ALREADY_CANCELLED" : "NOTHING_TO_RECOVER"],
      inputs: { state },
      policy_version: RECOVERY_POLICY_VERSION,
      next_actions: [{ action: "VERIFY", allowed: true }],
      now,
      ...(await withPrev(log)),
    });
  }
  await log.append(decision);
  return {
    status: httpForOutcome(decision.outcome),
    tripId: row.id,
    body: {
      trip_id: row.id,
      state,
      outcome: decision.outcome,
      decision_id: decision.decision_id,
      reason_codes: decision.reason_codes,
      ...(decision.reconcile_by ? { reconcile_by: decision.reconcile_by, message: "Do not retry. Intyr is checking and will update this trip." } : {}),
      stranded_spend_minor: doc.stranded_spend_minor,
      supplier_calls_made: 0,
      charged: false,
    },
  };
}

async function withPrev(log: DecisionLog): Promise<{ prev_decision_hash?: string }> {
  const prev = await log.prevHash();
  return prev ? { prev_decision_hash: prev } : {};
}

export async function runRecover(body: unknown, ctx: PaidContext, deps: ServiceDeps): Promise<HandlerResult> {
  const parsed = parseWith(RecoverRequestSchema, body);
  if (!parsed.ok) return { status: 422, body: { error: "INVALID_REQUEST", outcome: "REFUSE", reason_codes: ["INVALID_REQUEST"], issues: parsed.issues } };
  const owned = await getTripOnNetwork(deps, parsed.value.trip_id);
  if (!owned) return { status: 404, body: { error: "NOT_FOUND", outcome: "REFUSE", reason_codes: ["TRIP_STATE_CONFLICT"] } };
  if (!(await actorOwnsTrip(deps, owned, { ...(ctx.session?.payer ? { payer: ctx.session.payer } : {}), ...(ctx.sandboxSessionId ? { sandboxSessionId: ctx.sandboxSessionId } : {}) }))) return { ...NOT_TRIP_OWNER, feeFailure: "COMMIT_NOT_EXECUTED" };
  const result = await performRecovery(deps, parsed.value.trip_id, { allowReplacement: parsed.value.allow_replacement, headroomMinor: parsed.value.replacement_headroom_minor });
  const row = (await deps.store.getTrip(parsed.value.trip_id))!;
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const unknown = result.finalState === "COMMIT_STATUS_UNKNOWN";
  const fin = unknown ? null : await finalizeManifest(deps, parsed.value.trip_id, result.finalState, ctx.session);
  return {
    status: unknown ? 202 : 200,
    tripId: row.id,
    body: {
      trip_id: row.id,
      state: result.finalState,
      outcome: unknown ? "UNKNOWN" : "ACT",
      ...(unknown ? { message: "We have not confirmed the outcome of every component. Do not retry. Intyr is checking and will update this trip." } : {}),
      components: doc.components.map((c) => ({ component_id: c.component_id, state: c.state, cancellation: c.cancellation })),
      stranded_spend_minor: doc.stranded_spend_minor,
      decisions: result.decisions.map((d) => ({ decision_id: d.decision_id, outcome: d.outcome, reason_codes: d.reason_codes })),
      transaction_manifest_id: fin?.manifestId ?? null,
    },
  };
}
