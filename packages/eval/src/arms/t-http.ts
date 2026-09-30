import type { SimOrder } from "@intyr/adapters";

import type { ArmReport, ArmVerdict, BeliefState, ComponentBelief, TripSpec } from "../types";

/**
 * T: Intyr itself, driven as an external client over HTTP against the deployed
 * Worker's sandbox routes. The arm sees only what any caller sees: responses and
 * trip reads. Calls run under a sandbox session, which the server sponsors on
 * TestNet, so no USDC moves in the campaign.
 */

export interface HttpArmOptions {
  baseUrl: string;
  /** Declared trip limits sent with the intent. Recorded in the run manifest. */
  limits: { min_readiness?: number; max_price_move_pct?: number };
  pollSeconds?: number;
  timeoutSeconds?: number;
  fetch?: typeof fetch;
}

export interface HttpSession {
  cookie: string;
  calls: number;
}

interface TripRead {
  trip_id: string;
  state: string;
  components?: Array<{ component_id: string; state: string; refs?: { booking_id?: string | null } | null }>;
  manifest_id?: string | null;
  manifest_hash?: string | null;
  next_actions?: Array<{ action: string; allowed: boolean; reason?: string }>;
}

const TERMINAL = new Set(["COMMITTED", "COMMIT_NOT_EXECUTED", "RECOVERED", "RECOVERY_FAILED", "PREPARATION_FAILED", "CANCELLED", "CHECKED"]);
const STABLE_NON_TERMINAL = new Set(["MANUAL_REVIEW"]);

/** API component ids are `<type>-<n>`; the auditor must use the same ids the simulator stored. */
export function apiComponentId(type: string, index: number): string {
  return `${type.toLowerCase()}-${index + 1}`;
}

/** The sandbox scenario seed is an integer; derive it deterministically from the trip seed. */
export function numericSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h % 2 ** 31;
}

export function intentFor(trip: TripSpec, limits: HttpArmOptions["limits"]): Record<string, unknown> {
  return {
    trip_ref: trip.trip_id.slice(0, 64),
    currency: trip.currency,
    budget_total_minor: trip.max_total_minor,
    limits: { max_total_minor: trip.max_total_minor, ...limits },
    components: trip.components.map((c) => {
      if (c.type === "FLIGHT") return { type: "FLIGHT", origin: c.origin, destination: c.destination, depart_date: c.depart_date, passengers: c.adults };
      if (c.type === "HOTEL") return { type: "HOTEL", city: "New York", check_in: c.check_in, check_out: c.check_out, guests: c.adults };
      return { type: "GROUND", from: c.origin, to: c.destination, pickup_at: `${c.depart_date}T15:00:00Z`, passengers: c.adults };
    }),
    scenario: {
      seed: numericSeed(trip.seed),
      faults: trip.components.map((c, i) => ({ component_index: i, fault: c.sim?.scenario ?? "HAPPY" })),
    },
  };
}

function belief(state: string): BeliefState {
  if (state === "CONFIRMED") return "BOOKED";
  if (state === "CANCELLED" || state === "REPLACED") return "CANCELLED";
  if (["COMMIT_STATUS_UNKNOWN", "COMMIT_SUBMITTED", "COMMIT_RESPONDED", "CANCELLING", "RECOVERY_PENDING"].includes(state)) return "UNKNOWN";
  return "NOT_BOOKED";
}

function verdictOf(tripState: string, beliefs: ComponentBelief[]): ArmVerdict {
  if (beliefs.some((b) => b.belief === "UNKNOWN")) return "UNKNOWN";
  const booked = beliefs.filter((b) => b.belief === "BOOKED").length;
  if (tripState === "COMMITTED" && booked === beliefs.length) return "COMPLETE";
  if (booked === 0) return tripState === "PREPARATION_FAILED" || tripState === "COMMIT_NOT_EXECUTED" ? "ABORTED" : "UNWOUND";
  return "PARTIAL";
}

export class IntyrHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpArmOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async openSession(): Promise<HttpSession> {
    const res = await this.fetchImpl(`${this.options.baseUrl}/sandbox/session`, { method: "POST" });
    const setCookie = res.headers.get("set-cookie");
    if (!res.ok || !setCookie) throw new Error(`sandbox session failed: ${res.status}`);
    return { cookie: setCookie.split(";")[0]!, calls: 0 };
  }

  /**
   * GETs are retried on network errors because they change nothing. A POST that
   * fails on the network is not retried: the arm cannot know whether it reached
   * the Worker, so the harness records the run as a harness error instead.
   */
  async request<T>(session: HttpSession, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: T }> {
    session.calls += 1;
    const init: RequestInit = {
      method,
      headers: { cookie: session.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = method === "GET" ? await this.withRetry(() => this.fetchImpl(`${this.options.baseUrl}${path}`, init)) : await this.fetchImpl(`${this.options.baseUrl}${path}`, init);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return { status: res.status, body: parsed as T };
  }

  private async withRetry(call: () => Promise<Response>, attempts = 5): Promise<Response> {
    for (let i = 1; ; i++) {
      try {
        return await call();
      } catch (err) {
        if (i >= attempts) throw err;
        await sleep(2 * i);
      }
    }
  }

  async simOrders(seed: number): Promise<SimOrder[]> {
    const res = await this.withRetry(() => this.fetchImpl(`${this.options.baseUrl}/sandbox/v1/evidence/sim/${seed}/orders`));
    if (!res.ok) throw new Error(`evidence read failed: ${res.status}`);
    const body = (await res.json()) as { orders?: SimOrder[] };
    return body.orders ?? [];
  }
}

const sleep = (seconds: number): Promise<void> => new Promise((r) => setTimeout(r, seconds * 1000));

/** Runs one trip through Intyr over HTTP and reports the trip's own final view. */
export async function runT(trip: TripSpec, client: IntyrHttpClient, session: HttpSession, options: HttpArmOptions): Promise<{ report: ArmReport; trip_id: string | null; transcript: unknown[] }> {
  const transcript: unknown[] = [];
  const notes: string[] = [];
  const ids = trip.components.map((c, i) => apiComponentId(c.type, i));
  const report = (verdict: ArmVerdict, components: ComponentBelief[]): ArmReport => ({ arm: "T", trip_id: trip.trip_id, verdict, components, notes });

  const prep = await client.request<TripRead & { error?: string }>(session, "POST", "/sandbox/v1/trips/prepare", intentFor(trip, options.limits));
  transcript.push({ step: "prepare", status: prep.status, body: prep.body });
  if (prep.status >= 400 || !prep.body?.trip_id) {
    notes.push(`prepare refused: ${prep.status} ${prep.body?.error ?? ""}`);
    return { report: report("ABORTED", ids.map((id) => ({ component_id: id, belief: "NOT_BOOKED", booking_ids: [] }))), trip_id: null, transcript };
  }
  const tripId = prep.body.trip_id;
  const commitAllowed = prep.body.next_actions?.find((a) => a.action === "COMMIT")?.allowed ?? prep.body.state === "READY_TO_COMMIT";
  if (commitAllowed && prep.body.manifest_id && prep.body.manifest_hash) {
    const commit = await client.request<TripRead>(session, "POST", "/sandbox/v1/trips/commit", {
      trip_id: tripId,
      manifest_id: prep.body.manifest_id,
      manifest_hash: prep.body.manifest_hash,
      maximum_total_minor: trip.max_total_minor,
      currency: trip.currency,
      recovery_policy_acknowledged: true,
    });
    transcript.push({ step: "commit", status: commit.status, body: commit.body });
  } else {
    notes.push(`commit not allowed after prepare: state ${prep.body.state}`);
  }

  const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000;
  let read: TripRead | null = null;
  let recoverAsked = false;
  for (;;) {
    const r = await client.request<TripRead>(session, "GET", `/sandbox/v1/trips/${tripId}`);
    read = r.body;
    if (TERMINAL.has(read.state) || (STABLE_NON_TERMINAL.has(read.state) && Date.now() > deadline - 60_000)) break;
    const recover = read.next_actions?.find((a) => a.action === "RECOVER" && a.allowed);
    if (recover && !recoverAsked) {
      recoverAsked = true;
      const rec = await client.request<TripRead>(session, "POST", "/sandbox/v1/trips/recover", { trip_id: tripId });
      transcript.push({ step: "recover", status: rec.status, body: rec.body });
    }
    if (Date.now() > deadline) {
      notes.push(`trip still ${read.state} at the timeout`);
      break;
    }
    await sleep(options.pollSeconds ?? 4);
  }
  transcript.push({ step: "final", body: read });
  const components: ComponentBelief[] = ids.map((id) => {
    const c = read?.components?.find((x) => x.component_id === id);
    return { component_id: id, belief: c ? belief(c.state) : "NOT_BOOKED", booking_ids: c?.refs?.booking_id ? [c.refs.booking_id] : [] };
  });
  notes.push(`final trip state ${read?.state ?? "unknown"}`);
  return { report: report(verdictOf(read?.state ?? "", components), components), trip_id: tripId, transcript };
}
