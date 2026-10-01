import {
  CheckRequestSchema,
  CommitRequestSchema,
  parseWith,
  PublicTripIntentSchema,
  RecoverRequestSchema,
  RevalidateRequestSchema,
} from "@intyr/core";
import { NETWORKS, networkByCaip2, type FetchLike } from "@intyr/chain";

/** The most a stock `x402Client` 2.28.0 pays without `spendControls`, in USDC atomic units. */
export const STOCK_CLIENT_MAX_ATOMIC = 1_000_000;
export const CHALLENGE_TAG = "x402-global-challenge";

type RouteSchema = Parameters<typeof parseWith>[0];

/** Request schema of each paid route, keyed by the last path segment. */
export const ROUTE_SCHEMAS: Readonly<Record<string, RouteSchema>> = {
  check: CheckRequestSchema,
  prepare: PublicTripIntentSchema,
  revalidate: RevalidateRequestSchema,
  commit: CommitRequestSchema,
  recover: RecoverRequestSchema,
};

interface Accept {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  extra?: { tag?: string; feePayer?: string };
}

interface PaymentRequired {
  x402Version?: number;
  accepts?: Accept[];
  extensions?: { bazaar?: { info?: { input?: { body?: unknown } } } };
}

export interface RouteProbe {
  method: "POST" | "GET";
  url: string;
  /** Schema the route's Bazaar example body must satisfy. */
  schema?: RouteSchema;
}

export type ChallengeProblem =
  | "REFUSES_BEFORE_402"
  | "NOT_402"
  | "NO_PAYMENT_REQUIRED_HEADER"
  | "UNREADABLE_HEADER"
  | "NOT_X402_V2"
  | "NO_EXACT_ALGORAND_ACCEPT"
  | "TRUNCATED_NETWORK_ID"
  | "WRONG_NETWORK"
  | "WRONG_ASSET"
  | "PRICE_ABOVE_STOCK_CLIENT_LIMIT"
  | "PAY_TO_DIFFERS"
  | "MISSING_CHALLENGE_TAG"
  | "MISSING_FEE_PAYER"
  | "MISSING_BAZAAR_DECLARATION"
  | "BAZAAR_EXAMPLE_INVALID";

export interface ChallengeCheck {
  url: string;
  status: number;
  ok: boolean;
  problems: ChallengeProblem[];
  amount?: string;
  payTo?: string;
}

function decodeHeader(value: string): PaymentRequired | null {
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as PaymentRequired;
  } catch {
    return null;
  }
}

/**
 * Calls a paid route with an empty body and no payment, the way the
 * facilitator's x402 Doctor and listing refresh do, and checks the answer:
 * a 402 before any request validation, x402 V2, an exact-scheme Algorand
 * accept with the full-hash CAIP-2 id, USDC, a price a stock client will pay,
 * one payTo, the challenge tag, a fee payer and a Bazaar declaration whose
 * example body passes the route's own schema. Checking the body belongs to
 * the paid retry, before settlement.
 */
export async function checkChallenge(
  probe: RouteProbe,
  expected: { network: "mainnet" | "testnet"; payTo?: string },
  fetchFn: FetchLike = fetch,
): Promise<ChallengeCheck> {
  const res = await fetchFn(probe.url, { method: probe.method, headers: { "content-type": "application/json" }, body: "{}" });
  const base = { url: probe.url, status: res.status };
  if (res.status !== 402) {
    return { ...base, ok: false, problems: [res.status >= 400 && res.status < 500 ? "REFUSES_BEFORE_402" : "NOT_402"] };
  }
  const header = res.headers.get("payment-required");
  if (!header) return { ...base, ok: false, problems: ["NO_PAYMENT_REQUIRED_HEADER"] };
  const required = decodeHeader(header);
  if (!required) return { ...base, ok: false, problems: ["UNREADABLE_HEADER"] };

  const problems: ChallengeProblem[] = [];
  if (required.x402Version !== 2) problems.push("NOT_X402_V2");
  const net = NETWORKS[expected.network];
  const accept = required.accepts?.find((a) => a.scheme === "exact" && a.network?.startsWith("algorand:"));
  if (!accept) return { ...base, ok: false, problems: [...problems, "NO_EXACT_ALGORAND_ACCEPT"] };

  if (accept.network !== net.caip2) {
    problems.push(accept.network && net.caip2.startsWith(accept.network) ? "TRUNCATED_NETWORK_ID" : "WRONG_NETWORK");
  }
  if (accept.asset !== String(net.usdcAssetId)) problems.push("WRONG_ASSET");
  if (!accept.amount || !/^\d+$/.test(accept.amount) || Number(accept.amount) > STOCK_CLIENT_MAX_ATOMIC) {
    problems.push("PRICE_ABOVE_STOCK_CLIENT_LIMIT");
  }
  if (expected.payTo !== undefined && accept.payTo !== expected.payTo) problems.push("PAY_TO_DIFFERS");
  if (accept.extra?.tag !== CHALLENGE_TAG) problems.push("MISSING_CHALLENGE_TAG");
  if (!accept.extra?.feePayer) problems.push("MISSING_FEE_PAYER");
  const bazaar = required.extensions?.bazaar;
  if (!bazaar) problems.push("MISSING_BAZAAR_DECLARATION");
  else if (probe.schema && !parseWith(probe.schema, bazaar.info?.input?.body).ok) problems.push("BAZAAR_EXAMPLE_INVALID");

  return {
    ...base,
    ok: problems.length === 0,
    problems,
    ...(accept.amount ? { amount: accept.amount } : {}),
    ...(accept.payTo ? { payTo: accept.payTo } : {}),
  };
}

export interface DiscoveryResource {
  url: string;
  method: string;
  network: string;
  payTo: string;
}

/**
 * Reads `/.well-known/x402` and checks every paid route it lists on one
 * network. Only Mainnet routes belong in the Bazaar, so when the document
 * lists no TestNet routes, the sandbox mirror of each Mainnet route is probed
 * instead. On Mainnet all routes must share one payTo.
 */
export async function checkHostChallenges(
  host: string,
  network: "mainnet" | "testnet",
  fetchFn: FetchLike = fetch,
): Promise<{ payTo: string | null; checks: ChallengeCheck[] }> {
  const res = await fetchFn(`${host}/.well-known/x402`, { headers: { accept: "application/json" } });
  const doc = (res.ok ? await res.json() : { resources: [] }) as { resources?: DiscoveryResource[] };
  const listed = doc.resources ?? [];
  const onNetwork = (n: "mainnet" | "testnet") => listed.filter((r) => networkByCaip2(r.network)?.caip2 === NETWORKS[n].caip2);
  const mirrored = onNetwork("mainnet").map((r) => ({ ...r, url: r.url.replace("/v1/", "/sandbox/v1/"), payTo: "" }));
  const isMirror = network === "testnet" && onNetwork("testnet").length === 0;
  const resources = isMirror ? mirrored : onNetwork(network);
  const payTos = new Set(resources.map((r) => r.payTo).filter((p) => p !== ""));
  const payTo = payTos.size === 1 ? [...payTos][0]! : null;
  const checks = await Promise.all(
    resources.map((r) => {
      const path = new URL(r.url).pathname;
      const schema = ROUTE_SCHEMAS[path.slice(path.lastIndexOf("/") + 1)];
      return checkChallenge(
        { method: r.method === "GET" ? "GET" : "POST", url: r.url, ...(schema ? { schema } : {}) },
        { network, ...(payTo ? { payTo } : {}) },
        fetchFn,
      );
    }),
  );
  if (!isMirror) return { payTo, checks };
  // Mirrored sandbox routes are not listed with a payTo, so hold them to the one their own 402s name.
  const observed = new Set(checks.map((c) => c.payTo).filter((p): p is string => p !== undefined));
  return { payTo: observed.size === 1 ? [...observed][0]! : null, checks };
}
