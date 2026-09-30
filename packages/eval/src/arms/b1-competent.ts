/**
 * B1, the competent baseline: what a careful engineer builds in an afternoon
 * against the supplier API alone, with no commit service behind it. Written
 * only from packages/adapters/src/contract.ts (the supplier API) and
 * packages/eval/src/types.ts (the harness contract).
 *
 * Prepare every leg and abort if any fails or the trip breaks its budget.
 * Revalidate every leg and abort if a price moved. Book reversible legs before
 * irreversible ones, one commit each under a stable idempotency reference, and
 * settle every commit through a bounded series of status reads. Never resend a
 * commit. On a definite failure, cancel confirmed legs in reverse order. When a
 * leg cannot be settled, stop without booking or cancelling anything else and
 * report UNKNOWN.
 */

import type {
  AdapterCapabilities,
  CancelResult,
  CommitRequest,
  CommitResult,
  ComponentRequest,
  IntyrAdapter,
  Money,
  PostconditionResult,
  PreparedLeg,
  RevalidateResult,
  SupplierRefs,
} from "@intyr/adapters";

import type { Arm, ArmDeps, ArmReport, ArmVerdict, BeliefState, ComponentBelief, TripSpec } from "../types";

const ARM_ID = "B1";
const MAX_STATUS_READS = 6;
const MIN_WAIT_SECONDS = 2;
const MAX_WAIT_SECONDS = 60;
const MAX_CANCEL_ATTEMPTS = 2;

interface Leg {
  readonly req: ComponentRequest;
  readonly adapter: IntyrAdapter;
  readonly caps: AdapterCapabilities;
  readonly idempotencyRef: string;
  prepared: PreparedLeg;
  refs: SupplierRefs;
}

interface Run {
  readonly trip: TripSpec;
  readonly deps: ArmDeps;
  readonly notes: string[];
  readonly beliefs: Map<string, ComponentBelief>;
}

type SettledWhen = (read: PostconditionResult | null, lagPassed: boolean) => boolean;

export const runB1: Arm = async (trip, deps) => {
  const run: Run = { trip, deps, notes: [], beliefs: new Map() };
  if (trip.components.length === 0) {
    note(run, "trip has no components");
    return report(run, false);
  }

  const legs = await prepareAll(run);
  if (legs === null) return report(run, false);
  if (!withinBudget(run, legs) || !(await revalidateAll(run, legs))) {
    await releaseHolds(run, legs);
    return report(run, false);
  }

  const ordered = bookingOrder(legs);
  note(run, `booking order: ${ordered.map((leg) => leg.req.component_id).join(" -> ")}`);

  const confirmed: Leg[] = [];
  for (const [index, leg] of ordered.entries()) {
    const id = leg.req.component_id;
    const untouched = ordered.slice(index + 1);
    const { belief, charged } = await commitAndSettle(run, leg);

    if (belief === "BOOKED") {
      confirmed.push(leg);
      if (charged === null || !exceedsAgreedPrice(leg.prepared.price, charged)) continue;
      note(run, `${id}: confirmed at ${formatMoney(charged)} above the agreed ${formatMoney(leg.prepared.price)}; unwinding`);
      await unwind(run, confirmed, untouched);
      return report(run, true);
    }

    if (belief === "UNKNOWN") {
      note(run, `${id}: booking state unresolved; stopping with ${confirmed.length} confirmed leg(s) left in place`);
      await releaseHolds(run, untouched);
      return report(run, true);
    }

    note(run, `${id}: definite failure; cancelling ${confirmed.length} confirmed leg(s) in reverse order`);
    await unwind(run, confirmed, belief === "NOT_BOOKED" ? [leg, ...untouched] : untouched);
    return report(run, true);
  }

  return report(run, true);
};

async function prepareAll(run: Run): Promise<Leg[] | null> {
  const legs: Leg[] = [];
  for (const req of run.trip.components) {
    const leg = await prepareLeg(run, req);
    if (leg === null) {
      await releaseHolds(run, legs);
      return null;
    }
    legs.push(leg);
  }
  return legs;
}

async function prepareLeg(run: Run, req: ComponentRequest): Promise<Leg | null> {
  const id = req.component_id;
  try {
    const adapter = run.deps.adapterFor(req);
    const caps = adapter.capabilities();
    const result = await adapter.prepare(req);
    if (!result.ok) {
      note(run, `${id}: prepare failed with ${result.reason}: ${result.detail}`);
      return null;
    }
    return {
      req,
      adapter,
      caps,
      idempotencyRef: `${run.trip.trip_id}:${id}`,
      prepared: result.leg,
      refs: result.leg.refs,
    };
  } catch (err) {
    note(run, `${id}: prepare threw: ${describe(err)}`);
    return null;
  }
}

function withinBudget(run: Run, legs: readonly Leg[]): boolean {
  const { currency, max_total_minor } = run.trip;
  let total = 0;
  for (const leg of legs) {
    const id = leg.req.component_id;
    const { price } = leg.prepared;
    if (price.currency !== currency) {
      note(run, `${id}: priced in ${price.currency}, trip budget is in ${currency}`);
      return false;
    }
    if (leg.req.max_price_minor !== undefined && price.amount_minor > leg.req.max_price_minor) {
      note(run, `${id}: ${formatMoney(price)} exceeds the component cap ${leg.req.max_price_minor}`);
      return false;
    }
    total += price.amount_minor;
  }
  if (total > max_total_minor) {
    note(run, `prepared total ${total} ${currency} exceeds the trip cap ${max_total_minor}`);
    return false;
  }
  return true;
}

async function revalidateAll(run: Run, legs: readonly Leg[]): Promise<boolean> {
  for (const leg of legs) {
    const id = leg.req.component_id;
    let result: RevalidateResult;
    try {
      result = await leg.adapter.revalidate(leg.prepared);
    } catch (err) {
      note(run, `${id}: revalidate threw: ${describe(err)}`);
      return false;
    }
    const moved = !sameMoney(result.leg.price, leg.prepared.price);
    if (result.status === "PRICE_CHANGED" || result.status === "UNAVAILABLE" || moved) {
      note(
        run,
        `${id}: revalidation ${result.status}, ${formatMoney(leg.prepared.price)} -> ${formatMoney(result.leg.price)}`,
      );
      return false;
    }
    if (result.status === "UNKNOWN") {
      note(run, `${id}: could not revalidate (${result.detail ?? "no detail"}); commit stays capped at the prepared price`);
    }
    leg.prepared = result.leg;
    leg.refs = mergeRefs(leg.refs, result.leg.refs);
  }
  return true;
}

function bookingOrder(legs: readonly Leg[]): Leg[] {
  return [...legs].sort((a, b) => Number(!isReversible(a)) - Number(!isReversible(b)));
}

function isReversible(leg: Leg): boolean {
  return (
    !leg.prepared.irreversible && leg.caps.supports_cancel && leg.prepared.clocks.refund_destination !== "NONE"
  );
}

async function commitAndSettle(run: Run, leg: Leg): Promise<{ belief: BeliefState; charged: Money | null }> {
  const id = leg.req.component_id;
  const request: CommitRequest = {
    leg: leg.prepared,
    operation_id: `${leg.idempotencyRef}:commit`,
    idempotency_ref: leg.idempotencyRef,
    max_total: { ...leg.prepared.price },
    traveler: run.deps.traveler,
  };

  let commit: CommitResult | null = null;
  try {
    commit = await leg.adapter.commit(request);
    leg.refs = mergeRefs(leg.refs, commit.refs);
    run.deps.log("b1.commit", {
      component_id: id,
      response: commit.response,
      no_booking_certain: commit.no_booking_certain,
      error_code: commit.error_code,
    });
  } catch (err) {
    run.deps.log("b1.commit_threw", { component_id: id, error: describe(err) });
  }

  const committedAt = run.deps.now();
  const noBookingCertain = commit?.no_booking_certain === true;
  const rejected = commit?.response === "REJECTED";
  const lastKnown = await pollStatus(run, leg, committedAt, (read, lagPassed) => {
    if (read?.found === "PRESENT") return read.confirmed || read.cancelled;
    if (read?.found === "ABSENT" && read.absent_is_final) return true;
    return noBookingCertain || (rejected && lagPassed);
  });

  const belief = settledBelief(lastKnown, noBookingCertain || rejected);
  setBelief(run, leg, belief);
  note(run, `${id}: commit ${commit?.response ?? "threw"}, status ${lastKnown?.found ?? "unread"}, believed ${belief}`);
  return { belief, charged: lastKnown?.price ?? commit?.price ?? null };
}

/** A rejection that no status read contradicts counts as not booked, even without negative confirmation. */
function settledBelief(lastKnown: PostconditionResult | null, supplierSaidNo: boolean): BeliefState {
  if (lastKnown?.found === "PRESENT") {
    if (lastKnown.cancelled) return "CANCELLED";
    return lastKnown.confirmed ? "BOOKED" : "UNKNOWN";
  }
  if (lastKnown?.absent_is_final === true || supplierSaidNo) return "NOT_BOOKED";
  return "UNKNOWN";
}

function exceedsAgreedPrice(agreed: Money, charged: Money): boolean {
  return charged.currency === agreed.currency && charged.amount_minor > agreed.amount_minor;
}

/** Returns the last read that saw the booking or its absence. Refs learned along the way land on the leg. */
async function pollStatus(
  run: Run,
  leg: Leg,
  since: Date,
  settledWhen: SettledWhen,
): Promise<PostconditionResult | null> {
  let lastKnown: PostconditionResult | null = null;
  for (let attempt = 0; attempt < MAX_STATUS_READS && canReadStatus(leg); attempt++) {
    if (attempt > 0) await run.deps.sleep(waitSeconds(leg.caps, attempt));
    const read = await readStatus(run, leg);
    if (read !== null) {
      leg.refs = mergeRefs(leg.refs, read.refs);
      if (read.found !== "UNKNOWN") lastKnown = read;
    }
    if (settledWhen(read, secondsSince(run, since) >= leg.caps.visibility_lag_seconds)) break;
  }
  return lastKnown;
}

async function readStatus(run: Run, leg: Leg): Promise<PostconditionResult | null> {
  const id = leg.req.component_id;
  try {
    const read = hasBookingRef(leg.refs)
      ? await leg.adapter.postcondition(leg.prepared, leg.refs)
      : await leg.adapter.reconcileByReference(leg.prepared, leg.idempotencyRef);
    run.deps.log("b1.status", {
      component_id: id,
      found: read.found,
      confirmed: read.confirmed,
      cancelled: read.cancelled,
      absent_is_final: read.absent_is_final,
    });
    return read;
  } catch (err) {
    run.deps.log("b1.status_threw", { component_id: id, error: describe(err) });
    return null;
  }
}

function canReadStatus(leg: Leg): boolean {
  return hasBookingRef(leg.refs) || leg.caps.status_lookup !== "NONE";
}

function hasBookingRef(refs: SupplierRefs): boolean {
  return refs.booking_id !== null || refs.booking_reference !== null;
}

function waitSeconds(caps: AdapterCapabilities, attempt: number): number {
  const base = Math.max(MIN_WAIT_SECONDS, caps.visibility_lag_seconds);
  return Math.min(Math.max(MAX_WAIT_SECONDS, base), base * 2 ** (attempt - 1));
}

async function unwind(run: Run, confirmed: readonly Leg[], unbooked: readonly Leg[]): Promise<void> {
  await releaseHolds(run, unbooked);
  for (const leg of [...confirmed].reverse()) {
    await cancelLeg(run, leg);
  }
}

async function cancelLeg(run: Run, leg: Leg): Promise<void> {
  const id = leg.req.component_id;
  if (!leg.caps.supports_cancel) {
    note(run, `${id}: supplier does not support cancel; left booked`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_CANCEL_ATTEMPTS; attempt++) {
    const result = await requestCancel(run, leg);
    if (result?.outcome === "CANCELLED" || result?.outcome === "CANCELLED_WITH_CHARGES") {
      setBelief(run, leg, "CANCELLED");
      note(run, `${id}: ${result.outcome}${result.fee === null ? "" : `, fee ${formatMoney(result.fee)}`}`);
      return;
    }
    if (result?.outcome === "REFUSED") {
      note(run, `${id}: cancel refused (${result.detail ?? "no detail"}); left booked`);
      return;
    }

    const requestedAt = run.deps.now();
    const lastKnown = await pollStatus(run, leg, requestedAt, (read, lagPassed) => {
      if (read?.found === "PRESENT") return read.cancelled || lagPassed;
      return read?.found === "ABSENT" && read.absent_is_final;
    });
    const gone =
      (lastKnown?.found === "PRESENT" && lastKnown.cancelled) ||
      (lastKnown?.found === "ABSENT" && lastKnown.absent_is_final);
    if (gone) {
      setBelief(run, leg, "CANCELLED");
      note(run, `${id}: cancel response ${result?.outcome ?? "lost"}, status read shows it cancelled`);
      return;
    }
    if (!(lastKnown?.found === "PRESENT" && lastKnown.confirmed)) {
      setBelief(run, leg, "UNKNOWN");
      note(run, `${id}: cancel response ${result?.outcome ?? "lost"} and status unresolved`);
      return;
    }
  }
  note(run, `${id}: still booked after ${MAX_CANCEL_ATTEMPTS} cancel attempts`);
}

async function releaseHolds(run: Run, legs: readonly Leg[]): Promise<void> {
  for (const leg of legs) {
    const holdId = leg.refs.hold_order_id;
    if (holdId === null || !leg.caps.supports_cancel) continue;
    const result = await requestCancel(run, leg);
    note(run, `${leg.req.component_id}: released hold ${holdId}: ${result?.outcome ?? "no response"}`);
  }
}

async function requestCancel(run: Run, leg: Leg): Promise<CancelResult | null> {
  try {
    return await leg.adapter.cancel(leg.prepared, leg.refs);
  } catch (err) {
    run.deps.log("b1.cancel_threw", { component_id: leg.req.component_id, error: describe(err) });
    return null;
  }
}

function setBelief(run: Run, leg: Leg, belief: BeliefState): void {
  const id = leg.req.component_id;
  run.beliefs.set(id, { component_id: id, belief, booking_ids: bookingIds(leg.refs) });
}

function bookingIds(refs: SupplierRefs): string[] {
  const id = refs.booking_id ?? refs.booking_reference;
  return id === null ? [] : [id];
}

function report(run: Run, committedAny: boolean): ArmReport {
  const components = run.trip.components.map(
    (c): ComponentBelief =>
      run.beliefs.get(c.component_id) ?? { component_id: c.component_id, belief: "NOT_BOOKED", booking_ids: [] },
  );
  return {
    arm: ARM_ID,
    trip_id: run.trip.trip_id,
    verdict: verdictFor(components, committedAny),
    components,
    notes: run.notes,
  };
}

function verdictFor(components: readonly ComponentBelief[], committedAny: boolean): ArmVerdict {
  if (!committedAny) return "ABORTED";
  if (components.some((c) => c.belief === "UNKNOWN")) return "UNKNOWN";
  if (components.every((c) => c.belief === "BOOKED")) return "COMPLETE";
  return components.some((c) => c.belief === "BOOKED") ? "PARTIAL" : "UNWOUND";
}

function mergeRefs(base: SupplierRefs, next: SupplierRefs): SupplierRefs {
  return {
    offer_id: next.offer_id ?? base.offer_id,
    hold_order_id: next.hold_order_id ?? base.hold_order_id,
    prebook_id: next.prebook_id ?? base.prebook_id,
    booking_id: next.booking_id ?? base.booking_id,
    booking_reference: next.booking_reference ?? base.booking_reference,
    passenger_ids: next.passenger_ids.length > 0 ? next.passenger_ids : base.passenger_ids,
  };
}

function sameMoney(a: Money, b: Money): boolean {
  return a.amount_minor === b.amount_minor && a.currency === b.currency;
}

function formatMoney(money: Money): string {
  return `${money.amount_minor} ${money.currency}`;
}

function secondsSince(run: Run, since: Date): number {
  return (run.deps.now().getTime() - since.getTime()) / 1000;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function note(run: Run, message: string): void {
  run.notes.push(message);
  run.deps.log("b1.note", { trip_id: run.trip.trip_id, message });
}
