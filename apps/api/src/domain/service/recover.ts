import type { IntyrAdapter, PreparedLeg } from "@intyr/adapters";
import {
  buildTransactionManifest,
  canonicalize,
  decideRecoveryAction,
  hashValue,
  newId,
  signTransactionManifest,
  type ComponentState,
  type GateDecision,
  type ManifestComponent,
  type TripState,
} from "@intyr/core";
import type { PaymentSession } from "../../payments/sessions";
import type { TripComponentDoc, TripDoc } from "../trip-doc";
import { DecisionLog, type ServiceDeps } from "./context";
import { paymentRefs, toManifestComponent } from "./convert";
import { updateTripDoc } from "./trip-update";

export const RECOVERY_POLICY_VERSION = "public-default-v1";

/**
 * What a cancellation cost. The supplier's own fee wins. Without one, a refund in the leg's currency means the rest of the price
 * was kept. With neither, the cost is unknown, which is null and never zero.
 */
function cancellationFeeMinor(price: { amount_minor: number; currency: string }, fee: { amount_minor: number } | null, refund: { amount_minor: number; currency: string } | null): number | null {
  if (fee) return fee.amount_minor;
  if (refund && refund.currency === price.currency) return Math.max(0, price.amount_minor - refund.amount_minor);
  return null;
}

async function sha(value: unknown): Promise<string> {
  return hashValue(canonicalize(JSON.parse(JSON.stringify(value ?? null))));
}

export interface RecoveryOptions {
  allowReplacement: boolean;
  headroomMinor: number;
}

export interface RecoveryResult {
  finalState: TripState;
  decisions: GateDecision[];
}

async function componentToManifest(c: TripComponentDoc): Promise<ManifestComponent | null> {
  if (!c.leg) return null;
  const m = toManifestComponent(c.leg, c.state as ComponentState);
  return {
    ...m,
    ...(c.confirmation
      ? {
          confirmation: {
            supplier_ref_hash: await sha(c.refs),
            postcondition_hash: c.confirmation.response_hash ?? "",
            read_path: "adapter.postcondition",
            read_at: c.confirmation.read_at,
            evidence_tier: c.confirmation.evidence_tier as "E0" | "E1" | "E2",
          },
        }
      : {}),
    ...(c.outcome_verification ? { outcome_verification: c.outcome_verification } : {}),
  };
}

/**
 * Unwinds what can be undone, in reverse commit order, one gate decision per component. A component whose
 * status is unknown is never replaced or cancelled blind, and an irreversible component is reported, not hidden.
 */
export async function performRecovery(deps: ServiceDeps, tripId: string, opts: RecoveryOptions): Promise<RecoveryResult> {
  const now = deps.now();
  const log = new DecisionLog(deps.store, tripId, deps.now);
  const decisions: GateDecision[] = [];
  let row = (await deps.store.getTrip(tripId))!;
  let doc = JSON.parse(row.doc_json) as TripDoc;
  const order = [...doc.commit_order].reverse();
  let anyUnknown = false;

  for (const id of order) {
    const comp = doc.components.find((c) => c.component_id === id);
    if (!comp || !comp.leg) continue;
    const leg = comp.leg;
    const clocks = leg.clocks;
    const adapter = deps.adapters.get(leg.adapter_id);
    let quote: { cancellable: boolean; fee_minor: number | null } | null = null;
    if (adapter && comp.state === "CONFIRMED") {
      try {
        const q = await adapter.quoteCancellation(leg, comp.refs ?? leg.refs);
        quote = { cancellable: q.cancellable, fee_minor: cancellationFeeMinor(leg.price, q.fee, q.refund) };
      } catch {
        quote = null;
      }
    }
    const { decision, action } = await decideRecoveryAction(
      {
        trip_id: tripId,
        component: {
          component_id: id,
          state: comp.state as ComponentState,
          required: true,
          price: leg.price,
          refundable: !leg.irreversible,
          cancellation_fee_minor: null,
          free_cancel_until: clocks.free_cancel_until,
          void_until: clocks.void_until,
          has_hold: leg.preparation_mode === "HARD_HOLD" || leg.preparation_mode === "SOFT_HOLD",
        },
        cancel_quote: quote,
        replacement: { allowed: false, candidate_price_minor: null },
        headroom_minor: opts.headroomMinor,
        policy_version: RECOVERY_POLICY_VERSION,
        now,
      },
      await log.prevHash(),
    );
    await log.append(decision);
    decisions.push(decision);

    if (decision.outcome === "UNKNOWN") {
      anyUnknown = true;
      continue;
    }
    if (action !== "CANCEL" || comp.state !== "CONFIRMED") continue;

    if (!adapter) continue;
    const refs = comp.refs ?? leg.refs;
    const attempt = await deps.store.startAttempt({
      trip_id: tripId,
      component_id: id,
      action: "CANCEL",
      request_hash: await sha({ tripId, id, refs }),
      idempotency_ref: `cancel-${id}`,
      now: now.toISOString(),
    });
    await updateTripDoc(deps.store, tripId, now.toISOString(), (d) => {
      const c = d.components.find((x) => x.component_id === id);
      if (c) c.state = "CANCELLING";
    });
    const outcome = await cancelComponent(adapter, leg, refs);
    await deps.store.advanceAttempt(attempt.attempt.id, ["STARTED"], outcome.attemptState, { detail: outcome.detail }, deps.now().toISOString());
    await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
      const c = d.components.find((x) => x.component_id === id);
      if (!c) return;
      c.state = outcome.componentState;
      c.cancellation = outcome.cancellation;
    });
    if (outcome.componentState === "COMMIT_STATUS_UNKNOWN") anyUnknown = true;
  }

  row = (await deps.store.getTrip(tripId))!;
  doc = JSON.parse(row.doc_json) as TripDoc;
  const stillConfirmed = doc.components.filter((c) => c.state === "CONFIRMED");
  const cancelled = doc.components.filter((c) => c.state === "CANCELLED");
  let finalState: TripState;
  if (anyUnknown) finalState = "COMMIT_STATUS_UNKNOWN";
  else if (stillConfirmed.length > 0) finalState = "RECOVERY_FAILED";
  else if (cancelled.length === 0) finalState = "COMMIT_NOT_EXECUTED";
  else finalState = "RECOVERED";

  const stranded = stillConfirmed.reduce((sum, c) => sum + c.summary.price.amount_minor, 0) + cancelled.reduce((sum, c) => sum + (c.cancellation?.fee_minor ?? 0), 0);
  await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
    d.stranded_spend_minor = stranded;
    // A cancelled leg whose cost nobody stated is not closed, even when the known loss is zero.
    const costUnknown = cancelled.some((c) => c.refs?.booking_id && c.cancellation && c.cancellation.fee_minor == null);
    d.financial_closure = stranded > 0 || costUnknown ? "OPEN" : "CLOSED";
    d.next_actions = finalState === "COMMIT_STATUS_UNKNOWN" ? [{ action: "POLL", allowed: true }] : [{ action: "VERIFY", allowed: true }];
    return { state: finalState };
  });
  return { finalState, decisions };
}

async function cancelComponent(
  adapter: IntyrAdapter,
  leg: PreparedLeg,
  refs: PreparedLeg["refs"],
): Promise<{
  componentState: ComponentState;
  attemptState: "CONFIRMED" | "FAILED" | "UNKNOWN";
  cancellation: { outcome: string; refund_minor: number | null; fee_minor: number | null };
  detail: string | null;
}> {
  try {
    const result = await adapter.cancel(leg, refs);
    const post = await adapter.postcondition(leg, refs);
    const cancelledRead = post.found === "PRESENT" && post.cancelled;
    const cancellation = { outcome: result.outcome, refund_minor: result.refund?.amount_minor ?? null, fee_minor: cancellationFeeMinor(leg.price, result.fee, result.refund) };
    if ((result.outcome === "CANCELLED" || result.outcome === "CANCELLED_WITH_CHARGES") && cancelledRead) {
      return { componentState: "CANCELLED", attemptState: "CONFIRMED", cancellation, detail: result.detail };
    }
    if (result.outcome === "REFUSED") return { componentState: "CONFIRMED", attemptState: "FAILED", cancellation, detail: result.detail };
    return { componentState: "COMMIT_STATUS_UNKNOWN", attemptState: "UNKNOWN", cancellation, detail: result.detail ?? "cancel not confirmed by an independent read" };
  } catch (e) {
    return {
      componentState: "COMMIT_STATUS_UNKNOWN",
      attemptState: "UNKNOWN",
      cancellation: { outcome: "UNKNOWN", refund_minor: null, fee_minor: null },
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Builds, signs, stores and anchors the final transaction manifest of a trip. */
export async function finalizeManifest(
  deps: ServiceDeps,
  tripId: string,
  finalState: TripState,
  session: PaymentSession | null,
): Promise<{ manifestId: string; hash: string; signed: unknown }> {
  const row = (await deps.store.getTrip(tripId))!;
  const doc = JSON.parse(row.doc_json) as TripDoc;
  const active = await deps.store.getActiveManifest(tripId);
  const decisions = (await deps.store.listDecisions(tripId)) as GateDecision[];
  const components = (await Promise.all(doc.components.map(componentToManifest))).filter((c): c is ManifestComponent => c !== null);
  const manifest = await buildTransactionManifest({
    manifest_id: newId("man"),
    trip_id: tripId,
    environment: deps.environment,
    created_at: deps.now().toISOString(),
    commit_manifest_hash: active?.hash ?? doc.manifest_hash ?? "",
    final_state: finalState,
    components,
    decisions: decisions.map((d) => ({ decision_id: d.decision_id, gate: d.gate, outcome: d.outcome, reason_codes: d.reason_codes, decision_hash: d.decision_hash })),
    non_actions: decisions.filter((d) => d.outcome === "NO_ACTION").map((d) => ({ gate: d.gate, reason: d.reason_codes[0]!, subject: d.subject.component_id ?? d.subject.trip_id ?? "" })),
    inbound_payments: paymentRefs(session),
    outbound_payments: [],
    anchors: [],
    stranded_spend_minor: doc.stranded_spend_minor,
    assurance: { mode: "NONE" },
  });
  const signed = await signTransactionManifest(deps.key, manifest);
  await deps.store.putManifest({
    id: manifest.manifest_id,
    trip_id: tripId,
    kind: "TRANSACTION",
    hash: signed.payload_hash,
    status: "ACTIVE",
    expires_at: null,
    network: deps.environment.toLowerCase(),
    signed_json: JSON.stringify(signed),
    now: deps.now().toISOString(),
  });
  await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
    d.final_manifest_id = manifest.manifest_id;
  });
  if (deps.anchor) {
    try {
      const ref = await deps.anchor(manifest.manifest_id, signed.payload_hash);
      if (ref) {
        await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
          d.anchor = { state: ref.confirmed_round ? "CONFIRMED" : "PENDING", txid: ref.txid, mode: ref.mode };
        });
      }
    } catch {
      await updateTripDoc(deps.store, tripId, deps.now().toISOString(), (d) => {
        d.anchor = { state: "PENDING", txid: null, mode: "SEPARATE_NOTE_TRANSACTION" };
      });
    }
  }
  return { manifestId: manifest.manifest_id, hash: signed.payload_hash, signed };
}
