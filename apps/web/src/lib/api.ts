import type {
  DemoRun,
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
  TripRequest,
  TripSummary,
  VerifyResult,
  VersionInfo,
  CallerLeg,
  Money,
} from "./types";

/**
 * The UI works against the sandbox mirror (TestNet, server-held payer, cookie session).
 * The public verifier reads manifests through /v1, which resolves ids on both networks.
 */
export const SANDBOX = "/sandbox/v1";
export const PUBLIC = "/v1";

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
}

export const api = {
  listTrips: (signal?: AbortSignal) => sandbox<{ trips: TripSummary[] } | TripSummary[]>("GET", "/trips", undefined, signal).then(unwrapList),
  getTrip: (tripId: string, signal?: AbortSignal) => sandbox<Trip | { trip: Trip }>("GET", `/trips/${encodeURIComponent(tripId)}`, undefined, signal).then(unwrapTrip),
  getOperation: (operationId: string, signal?: AbortSignal) => sandbox<Operation>("GET", `/operations/${encodeURIComponent(operationId)}`, undefined, signal),

  checkTrip: (body: { legs: CallerLeg[]; budget_total: Money; label?: string }) => sandbox<ActionResponse>("POST", "/trips/check", body),
  prepareTrip: (body: TripRequest) => sandbox<ActionResponse>("POST", "/trips/prepare", body),
  revalidateTrip: (tripId: string) => sandbox<ActionResponse>("POST", "/trips/revalidate", { trip_id: tripId }),
  commitTrip: (tripId: string, manifestHash: string) => sandbox<ActionResponse>("POST", "/trips/commit", { trip_id: tripId, manifest_hash: manifestHash }),
  recoverTrip: (tripId: string) => sandbox<ActionResponse>("POST", "/trips/recover", { trip_id: tripId }),
  approveTrip: (tripId: string, body: { manifest_hash: string; decision: "APPROVE" | "REJECT"; note?: string }) =>
    sandbox<ActionResponse>("POST", `/trips/${encodeURIComponent(tripId)}/approve`, body),
  runDemo: (scenario?: string) => sandbox<DemoRun>("POST", "/demo/run", scenario ? { scenario } : {}),

  getManifest: (manifestId: string, signal?: AbortSignal) => request<ManifestDocument>("GET", `${PUBLIC}/manifests/${encodeURIComponent(manifestId)}`, undefined, signal),
  verifyManifest: (body: { manifest_id?: string; manifest?: unknown; txid?: string }) => request<VerifyResult>("POST", `${PUBLIC}/manifests/verify`, body),
  getPrices: (base: typeof PUBLIC | typeof SANDBOX = PUBLIC, signal?: AbortSignal) => request<PriceTable>("GET", `${base}/prices`, undefined, signal),
  getStats: (signal?: AbortSignal) => request<PublicStats>("GET", `${PUBLIC}/stats/public`, undefined, signal),
  getEvidenceRun: (runId: string, signal?: AbortSignal) => request<EvidenceRun>("GET", `${PUBLIC}/evidence/runs/${encodeURIComponent(runId)}`, undefined, signal),
  getVersion: (signal?: AbortSignal) => request<VersionInfo>("GET", "/version", undefined, signal),
  getSigningKeys: (signal?: AbortSignal) => request<{ keys: Array<{ key_id: string; public_key: string; revoked?: boolean }> }>("GET", "/.well-known/intyr-signing-keys.json", undefined, signal),
};

function unwrapList(r: { trips: TripSummary[] } | TripSummary[]): TripSummary[] {
  return Array.isArray(r) ? r : r.trips;
}

function unwrapTrip(r: Trip | { trip: Trip }): Trip {
  return "trip" in r && r.trip ? r.trip : (r as Trip);
}
