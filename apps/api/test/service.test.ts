import { describe, expect, it } from "vitest";
import { MemorySimulatorStore, createAdapters, type IntyrAdapter } from "@intyr/adapters";
import { generateSigningKey, publishedKey, verifyManifestDocument, type CommitManifest, type GateDecision, type Signed, type TransactionManifest } from "@intyr/core";
import type { PaymentSession } from "../src/payments/sessions";
import type { PaidContext } from "../src/payments/ladder";
import { TripStore } from "../src/domain/store";
import type { ServiceDeps } from "../src/domain/service/context";
import { runPrepare, parseIntent, runRevalidate, precheckRevalidate } from "../src/domain/service/prepare";
import { precheckCommit, runCommit, reconcileUnknownTrips } from "../src/domain/service/commit";
import { precheckRecover, runRecover } from "../src/domain/service/recover-route";
import type { TripDoc } from "../src/domain/trip-doc";
import { createTestD1 } from "./support/d1";

const session = (route: string): PaymentSession => ({
  id: "pay_test",
  txid: "TX",
  route,
  body_hash: "sha256:x",
  network: "algorand:test",
  asset: "10458941",
  amount: "250000",
  pay_to: "PAYTO",
  payer: "PAYER",
  payer_class: "EXTERNAL_ANON",
  state: "CONFIRMED",
  first_valid: 1,
  last_valid: 2,
  settle_json: null,
  confirmed_round: 10,
  operation_id: "ops_test",
  last_error: null,
  created_at: "",
  updated_at: "",
});

const ctx = (route: string, body: unknown): PaidContext => ({ network: "testnet", sponsored: false, body, session: session(route), operationId: "ops_test", now: new Date().toISOString() });

async function setup(now = new Date()) {
  const db = createTestD1();
  const store = new TripStore(db);
  const clock = { now: () => new Date(clockState.t) };
  const clockState = { t: now.getTime() };
  const key = await generateSigningKey("test-key");
  const adapters = createAdapters({}, { simulatorStore: new MemorySimulatorStore(), clock, simulatorLagSeconds: 30 });
  const deps: ServiceDeps = { store, adapters, key, environment: "TESTNET", allowScenario: true, now: () => new Date(clockState.t) };
  return { deps, store, key, clockState };
}

const baseIntent = (faults: unknown[] = []) => ({
  currency: "USD",
  budget_total_minor: 2_000_00,
  components: [
    { type: "HOTEL", city: "London", check_in: "2026-11-01", check_out: "2026-11-03", guests: 1 },
    { type: "FLIGHT", origin: "JFK", destination: "LHR", depart_date: "2026-11-01", passengers: 1 },
    { type: "GROUND", from: "LHR", to: "Central London", pickup_at: "2026-11-01T18:00:00Z", passengers: 1 },
  ],
  limits: { min_readiness: 30 },
  scenario: { seed: 7, faults },
});

async function prepare(s: Awaited<ReturnType<typeof setup>>, intent: unknown) {
  const p = parseIntent(intent);
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  const res = await runPrepare(p.value, ctx("POST /sandbox/v1/trips/prepare", intent), s.deps);
  return res;
}

function commitBody(tripId: string, prep: { body: Record<string, unknown> }) {
  return {
    trip_id: tripId,
    manifest_id: prep.body.manifest_id,
    manifest_hash: prep.body.manifest_hash,
    maximum_total_minor: 10_000_00,
    currency: "USD",
    recovery_policy_acknowledged: true,
  };
}

async function tripDoc(s: Awaited<ReturnType<typeof setup>>, id: string): Promise<{ state: string; doc: TripDoc }> {
  const row = (await s.store.getTrip(id))!;
  return { state: row.state, doc: JSON.parse(row.doc_json) as TripDoc };
}

describe("prepare and commit through the simulator", () => {
  it("prepares three legs, commits them in order and ends COMMITTED with a verifiable transaction manifest", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    expect(prep.status).toBe(200);
    const tripId = prep.tripId!;
    expect(["PREPARED", "PREPARED_WITH_WARNINGS"]).toContain(prep.body.state);

    const body = commitBody(tripId, prep);
    expect(await precheckCommit(body, s.deps)).toBeNull();
    const res = await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("COMMITTED");
    const { doc } = await tripDoc(s, tripId);
    expect(doc.components.every((c) => c.state === "CONFIRMED")).toBe(true);
    expect(doc.components.every((c) => c.summary.evidence_grade === "SIMULATED")).toBe(true);

    const manifestRow = (await s.store.getManifest(res.body.transaction_manifest_id as string))!;
    const signed = JSON.parse(manifestRow.signed_json) as Signed<TransactionManifest>;
    const check = await verifyManifestDocument(signed, [publishedKey(s.key, "2026-09-30T00:00:00Z")]);
    expect(check).toEqual({ ok: true });
    expect(signed.payload.final_state).toBe("COMMITTED");
    expect(signed.payload.evidence_banner).toBe("SIMULATED");
  });

  it("answers a repeated commit with NO_ACTION for free and makes no second supplier call", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    const tripId = prep.tripId!;
    const body = commitBody(tripId, prep);
    await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    const attemptsBefore = (await s.store.listAttempts(tripId)).length;
    const replay = await precheckCommit(body, s.deps);
    expect(replay?.status).toBe(200);
    expect(replay?.body.outcome).toBe("NO_ACTION");
    expect(replay?.body.reason_codes).toContain("COMMIT_ALREADY_COMPLETED");
    expect(replay?.body.charged).toBe(false);
    expect((await s.store.listAttempts(tripId)).length).toBe(attemptsBefore);
  });

  it("refuses a commit for a manifest hash that was not prepared, before any charge", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    const body = { ...commitBody(prep.tripId!, prep), manifest_hash: "sha256:" + "0".repeat(64) };
    const refused = await precheckCommit(body, s.deps);
    expect(refused?.status).toBe(422);
    expect(refused?.body.reason_codes).toContain("MANIFEST_HASH_MISMATCH");
    expect(refused?.body.charged).toBe(false);
  });

  it("rejects a seeded fault scenario on a host that does not allow it", async () => {
    const s = await setup();
    s.deps.allowScenario = false;
    const res = await prepare(s, baseIntent([{ component_index: 0, fault: "COMMIT_REJECT" }]));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SCENARIO_NOT_ALLOWED");
  });
});

describe("failure handling", () => {
  it("unwinds confirmed reversible legs when a later leg is rejected, and ends RECOVERED with no stranded spend", async () => {
    const s = await setup();
    // Component 1 is the flight. Rejecting it after the other legs confirmed must cancel them.
    const prep = await prepare(s, baseIntent([{ component_index: 1, fault: "COMMIT_REJECT" }]));
    const tripId = prep.tripId!;
    const body = commitBody(tripId, prep);
    const res = await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    expect(res.body.state).toBe("RECOVERED");
    const { doc } = await tripDoc(s, tripId);
    const byId = Object.fromEntries(doc.components.map((c) => [c.component_id, c.state]));
    expect(byId).toEqual({ "ground-3": "CANCELLED", "hotel-1": "CANCELLED", "flight-2": "COMMIT_FAILED" });
    expect(doc.stranded_spend_minor).toBe(0);
    const decisions = (await s.store.listDecisions(tripId)) as Array<{ gate: string; outcome: string }>;
    expect(decisions.filter((d) => d.gate === "RECOVERY_ACTION").length).toBe(3);
    const attempts = await s.store.listAttempts(tripId);
    // The rejected flight was written once and never retried.
    expect(attempts.filter((a) => a.component_id === "flight-2" && a.action === "COMMIT")).toHaveLength(1);
  });

  it("treats a timeout as unknown, never rewrites that leg, starts no later leg, then resumes forward once the supplier is read", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent([{ component_index: 0, fault: "TIMEOUT_BOOKED" }]));
    const tripId = prep.tripId!;
    const body = commitBody(tripId, prep);
    const res = await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("UNKNOWN");
    expect(res.body.message).toContain("Do not retry");
    const paused = await tripDoc(s, tripId);
    expect(paused.state).toBe("COMMIT_STATUS_UNKNOWN");
    expect(paused.doc.components.find((c) => c.component_id === "hotel-1")?.state).toBe("COMMIT_STATUS_UNKNOWN");
    // The flight, which comes after the unknown hotel in the commit order, was never submitted.
    expect(paused.doc.components.find((c) => c.component_id === "flight-2")?.state).toBe("PREPARED");

    // While unknown, a second commit is a free replay and recovery refuses to act blind.
    const replay = await precheckCommit(body, s.deps);
    expect(replay?.body.outcome).toBe("NO_ACTION");
    expect(replay?.body.reason_codes).toContain("COMMIT_ALREADY_STARTED");
    const pre = await precheckRecover({ trip_id: tripId }, s.deps);
    expect(pre?.body.outcome).toBe("UNKNOWN");
    const hotelAttempts = () => s.store.listAttempts(tripId).then((a) => a.filter((x) => x.component_id === "hotel-1" && x.action === "COMMIT"));
    expect(await hotelAttempts()).toHaveLength(1);

    // After the supplier's visibility lag the reconciler reads the booking by our reference and the commit continues.
    s.clockState.t += 120_000;
    const resolved = await reconcileUnknownTrips(s.deps, async () => session("POST /sandbox/v1/trips/commit"));
    expect(resolved).toBe(1);
    const final = await tripDoc(s, tripId);
    expect(final.state).toBe("COMMITTED");
    expect(final.doc.components.every((c) => c.state === "CONFIRMED")).toBe(true);
    expect(await hotelAttempts()).toHaveLength(1);
  });

  it("resumes a sponsored sandbox commit that has no payment session, and leaves a Mainnet trip without one alone", async () => {
    const s = await setup();
    const sponsored = (route: string, body: unknown): PaidContext => ({ network: "testnet", sponsored: true, sandboxSessionId: "sbx_test", body, session: null, operationId: "spons_test", now: new Date().toISOString() });
    const prep = await prepare(s, baseIntent([{ component_index: 0, fault: "TIMEOUT_BOOKED" }]));
    const tripId = prep.tripId!;
    const body = commitBody(tripId, prep);
    const res = await runCommit(body, sponsored("POST /sandbox/v1/trips/commit", body), s.deps);
    expect(res.status).toBe(202);
    s.clockState.t += 120_000;

    expect(await reconcileUnknownTrips({ ...s.deps, environment: "MAINNET" }, async () => null)).toBe(0);
    expect((await tripDoc(s, tripId)).state).toBe("COMMIT_STATUS_UNKNOWN");

    expect(await reconcileUnknownTrips(s.deps, async () => null)).toBe(1);
    const final = await tripDoc(s, tripId);
    expect(final.state).toBe("COMMITTED");
    expect(final.doc.components.every((c) => c.state === "CONFIRMED")).toBe(true);
  });

  it("answers recover on a healthy committed trip with NO_ACTION and zero supplier calls, without charge", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    const tripId = prep.tripId!;
    const body = commitBody(tripId, prep);
    await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    const pre = await precheckRecover({ trip_id: tripId }, s.deps);
    expect(pre?.body.outcome).toBe("NO_ACTION");
    expect(pre?.body.supplier_calls_made).toBe(0);
    expect(pre?.body.charged).toBe(false);
  });
});

describe("sandbox supplier policy", () => {
  /** The simulator, presented as a supplier sandbox, so the trip carries SUPPLIER_SANDBOX evidence. */
  function asSupplierSandbox(adapter: IntyrAdapter): IntyrAdapter {
    return new Proxy(adapter, {
      get(target, prop) {
        if (prop === "prepare") {
          return async (req: Parameters<IntyrAdapter["prepare"]>[0]) => {
            const res = await target.prepare(req);
            return res.ok ? { ...res, leg: { ...res.leg, evidence_grade: "SUPPLIER_SANDBOX" as const, leg_class: "SUPPLIER_SANDBOX" as const } } : res;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  const nonRefundableFlight = () => baseIntent([{ component_index: 1, fault: "NON_REFUNDABLE" }]);

  it("sends a below-threshold trip of supplier sandbox legs to approval, and refuses the same trip when simulated", async () => {
    const simulated = await setup();
    const refused = await prepare(simulated, nonRefundableFlight());
    const refusedDecision = ((await simulated.store.listDecisions(refused.tripId!)) as GateDecision[]).find((d) => d.gate === "PREPARE");
    expect(refusedDecision).toMatchObject({ outcome: "REFUSE", reason_codes: ["READINESS_BELOW_THRESHOLD"], policy_version: "public-default-v1" });

    const s = await setup();
    const real = s.deps.adapters;
    s.deps.adapters = { get: (id) => real.get(id) && asSupplierSandbox(real.get(id)!), all: () => real.all().map(asSupplierSandbox), forType: (t, o) => { const a = real.forType(t, o); return a && asSupplierSandbox(a); } };
    const prep = await prepare(s, nonRefundableFlight());
    const decisions = (await s.store.listDecisions(prep.tripId!)) as GateDecision[];
    expect(decisions.find((d) => d.gate === "PREPARE")).toMatchObject({ outcome: "MANUAL_REVIEW", policy_version: "sandbox-supplier-v1", required_role: "SESSION_APPROVER" });

    const body = commitBody(prep.tripId!, prep);
    const before = await precheckCommit(body, s.deps);
    expect(before?.body.outcome).toBe("MANUAL_REVIEW");

    await s.store.putApproval({ trip_id: prep.tripId!, manifest_hash: String(prep.body.manifest_hash), decision: "APPROVE", actor: "session:test", now: new Date().toISOString() });
    expect(await precheckCommit(body, s.deps)).toBeNull();
    const done = await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    expect(done.body.outcome).toBe("ACT");
    const commitGate = ((await s.store.listDecisions(prep.tripId!)) as GateDecision[]).filter((d) => d.gate === "COMMIT").pop();
    expect(commitGate?.policy_version).toBe("sandbox-supplier-v1");
  });

  it("never applies it on Mainnet", async () => {
    const s = await setup();
    s.deps.environment = "MAINNET";
    s.deps.allowScenario = false;
    const real = s.deps.adapters;
    s.deps.adapters = { get: (id) => real.get(id) && asSupplierSandbox(real.get(id)!), all: () => real.all().map(asSupplierSandbox), forType: (t, o) => { const a = real.forType(t, o); return a && asSupplierSandbox(a); } };
    const intent = { ...baseIntent(), scenario: undefined };
    const prep = await prepare(s, intent);
    const decision = ((await s.store.listDecisions(prep.tripId!)) as GateDecision[]).find((d) => d.gate === "PREPARE");
    expect(decision?.policy_version).toBe("public-default-v1");
  });
});

describe("revalidate", () => {
  it("refuses a bad body, an unknown trip and a trip in the wrong state before any charge", async () => {
    const s = await setup();
    const bad = await precheckRevalidate({}, s.deps);
    expect(bad).toMatchObject({ status: 422, body: { error: "INVALID_REQUEST", charged: false } });
    const unknown = await precheckRevalidate({ trip_id: "trp_000000000000000000000000" }, s.deps);
    expect(unknown).toMatchObject({ status: 404, body: { reason_codes: ["TRIP_STATE_CONFLICT"], charged: false } });

    const prep = await prepare(s, baseIntent());
    expect(await precheckRevalidate({ trip_id: prep.tripId }, s.deps)).toBeNull();
    const body = commitBody(prep.tripId!, prep);
    await runCommit(body, ctx("POST /sandbox/v1/trips/commit", body), s.deps);
    const committed = await precheckRevalidate({ trip_id: prep.tripId }, s.deps);
    expect(committed).toMatchObject({ status: 409, body: { error: "TRIP_STATE_CONFLICT", state: "COMMITTED", charged: false } });
  });

  it("returns the same manifest when nothing moved", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    const res = await runRevalidate({ trip_id: prep.tripId }, ctx("POST /sandbox/v1/trips/revalidate", {}), s.deps);
    expect(res.status).toBe(200);
    expect(res.body.manifest_changed).toBe(false);
    expect(res.body.manifest_hash).toBe(prep.body.manifest_hash);
  });
});

describe("manifests", () => {
  it("signs commit manifests that verify and show the weakest evidence grade", async () => {
    const s = await setup();
    const prep = await prepare(s, baseIntent());
    const signed = prep.body.manifest as Signed<CommitManifest>;
    expect(await verifyManifestDocument(signed, [publishedKey(s.key, "2026-09-30T00:00:00Z")])).toEqual({ ok: true });
    expect(signed.payload.evidence_banner).toBe("SIMULATED");
    expect(signed.payload.assurance.mode).toBe("NONE");
    expect(signed.payload.commit_order).toHaveLength(3);
  });
});
