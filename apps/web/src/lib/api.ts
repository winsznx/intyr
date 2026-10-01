import type {
  DemoRun,
  DemoScenario,
  Environment,
  EvidenceRun,
  GateDecision,
  ManifestDocument,
  NextAction,
  Operation,
  PaymentState,
  PriceTable,
  PublicStats,
  SandboxSession,
  Trip,
  TripIntent,
  CheckRequest,
  TripSummary,
  VerifyResult,
  VersionInfo,
} from "./types";
import { normalizeList, normalizeTrip } from "./trip-wire";

/**
 * The UI works against the sandbox mirror (TestNet, server-held payer, cookie session).
 * /v1 holds MainNet records and /sandbox/v1 holds TestNet records. Each host checks
 * anchors on its own network only.
 */
export const SANDBOX = "/sandbox/v1";
export const PUBLIC = "/v1";

export type ApiBase = typeof PUBLIC | typeof SANDBOX;

export function baseForEnvironment(environment: Environment | undefined): ApiBase | undefined {
  if (environment === "TESTNET") return SANDBOX;
  if (environment === "MAINNET") return PUBLIC;
  return undefined;
}

export type VerifyBody = { manifest_id: string } | { signed: Record<string, unknown> } | { txid: string };

export interface ApiErrorBody {
  error?: string;
  message?: string;
  decision?: GateDecision;
  reason_codes?: string[];
  payment_state?: PaymentState;
  payment_txid?: string;
  next_actions?: NextAction[];
  supplier_action_may_have_occurred?: boolean;
  current_manifest?: ManifestDocument;
  retry_after?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody, fallback: string) {
    super(body.message ?? body.error ?? fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error ?? (status === 0 ? "NETWORK_UNAVAILABLE" : `HTTP_${status}`);
    this.body = body;
  }

  /** The service could not be reached at all (no HTTP response). */
  get unreachable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 504;
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, {}, "The Intyr API could not be reached.");
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const errorBody = parsed && typeof parsed === "object" ? (parsed as ApiErrorBody) : {};
    throw new ApiError(response.status, errorBody, `Request failed with status ${response.status}.`);
  }
  if (parsed === undefined) {
    throw new ApiError(response.status, { error: "INVALID_RESPONSE" }, "The API returned a response the page could not read.");
  }
  return parsed as T;
}

let sessionPromise: Promise<SandboxSession> | null = null;

/** Creates the anonymous 24 hour sandbox session once per page load. The cookie is HttpOnly. */
export function ensureSandboxSession(): Promise<SandboxSession> {
  if (!sessionPromise) {
    sessionPromise = request<SandboxSession>("POST", "/sandbox/session").catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

async function sandbox<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  await ensureSandboxSession();
  try {
    return await request<T>(method, `${SANDBOX}${path}`, body, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      sessionPromise = null;
      await ensureSandboxSession();
      return request<T>(method, `${SANDBOX}${path}`, body, signal);
    }
    throw error;
  }
}

export interface ActionResponse {
  trip?: Trip;
  trip_id?: string;
  operation_id?: string;
  decision?: GateDecision;
  payment_state?: PaymentState;
  payment_txid?: string;
  next_actions?: NextAction[];
  manifest_id?: string;
  manifest_hash?: string;
  supplier_action_may_have_occurred?: boolean;
  state?: string;
  plan_id?: string;
  verdict?: string;
  outcome?: string;
  reason_codes?: string[];
  failures?: Array<{ component_id: string; reason: string; detail?: string }>;
  no_booking_occurred?: boolean;
}

export const api = {
  listTrips: (signal?: AbortSignal): Promise<TripSummary[]> => sandbox<unknown>("GET", "/trips", undefined, signal).then(normalizeList),
  getTrip: (tripId: string, signal?: AbortSignal): Promise<Trip> => sandbox<unknown>("GET", `/trips/${encodeURIComponent(tripId)}`, undefined, signal).then(normalizeTrip),
  getOperation: (operationId: string, signal?: AbortSignal) => sandbox<Operation>("GET", `/operations/${encodeURIComponent(operationId)}`, undefined, signal),

  checkTrip: (body: CheckRequest) => sandbox<ActionResponse>("POST", "/trips/check", body),
  prepareTrip: (body: TripIntent) => sandbox<ActionResponse>("POST", "/trips/prepare", body),
  revalidateTrip: (tripId: string) => sandbox<ActionResponse>("POST", "/trips/revalidate", { trip_id: tripId }),
  commitTrip: (body: { trip_id: string; manifest_id: string; manifest_hash: string; maximum_total_minor: number; currency: string }) =>
    sandbox<ActionResponse>("POST", "/trips/commit", { ...body, recovery_policy_acknowledged: true }),
  recoverTrip: (tripId: string, options: { allow_replacement?: boolean; replacement_headroom_minor?: number } = {}) =>
    sandbox<ActionResponse>("POST", "/trips/recover", { trip_id: tripId, allow_replacement: options.allow_replacement ?? true, replacement_headroom_minor: options.replacement_headroom_minor ?? 0 }),
  approveTrip: (tripId: string, body: { manifest_hash: string; decision: "APPROVE" | "REJECT"; note?: string }) =>
    sandbox<ActionResponse>("POST", `/trips/${encodeURIComponent(tripId)}/approve`, body),
  getDemoScenarios: (signal?: AbortSignal): Promise<DemoScenario[]> =>
    sandbox<DemoScenario[] | { scenarios?: DemoScenario[]; items?: DemoScenario[] }>("GET", "/demo/scenarios", undefined, signal).then((r) => (Array.isArray(r) ? r : (r.scenarios ?? r.items ?? []))),
  runDemo: (scenario: string, seed?: number) =>
    sandbox<DemoRun & { prepared?: ActionResponse }>("POST", "/demo/run", seed === undefined ? { scenario } : { scenario, seed }),

  getManifest: (manifestId: string, signal?: AbortSignal) => request<ManifestDocument>("GET", `${PUBLIC}/manifests/${encodeURIComponent(manifestId)}`, undefined, signal),
  verifyManifest: (body: VerifyBody, base: ApiBase = PUBLIC) => request<VerifyResult>("POST", `${base}/manifests/verify`, body),
  /**
   * Asks the host of the record's own network when it is known, because the other host
   * would look for the anchor on the wrong chain. Otherwise MainNet first, and a 404 falls
   * through to the sandbox host.
   */
  verifyAnywhere: async (body: VerifyBody, environment?: Environment): Promise<VerifyResult & { answered_by: ApiBase }> => {
    const known = baseForEnvironment(environment);
    if (known) return { ...(await request<VerifyResult>("POST", `${known}/manifests/verify`, body)), answered_by: known };
    try {
      return { ...(await request<VerifyResult>("POST", `${PUBLIC}/manifests/verify`, body)), answered_by: PUBLIC };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return { ...(await request<VerifyResult>("POST", `${SANDBOX}/manifests/verify`, body)), answered_by: SANDBOX };
    }
  },
  getPrices: (base: ApiBase = PUBLIC, signal?: AbortSignal) => request<PriceTable>("GET", `${base}/prices`, undefined, signal),
  getStats: (signal?: AbortSignal) => request<PublicStats>("GET", `${PUBLIC}/stats/public`, undefined, signal),
  getEvidenceRun: (runId: string, signal?: AbortSignal) => request<EvidenceRun>("GET", `${PUBLIC}/evidence/runs/${encodeURIComponent(runId)}`, undefined, signal),
  getVersion: (signal?: AbortSignal) => request<VersionInfo>("GET", "/version", undefined, signal),
  getSigningKeys: (signal?: AbortSignal) => request<{ keys: Array<{ key_id: string; public_key: string; revoked?: boolean }> }>("GET", "/.well-known/intyr-signing-keys.json", undefined, signal),
};
