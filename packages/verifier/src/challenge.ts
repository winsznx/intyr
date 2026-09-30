import { NETWORKS, networkByCaip2, type FetchLike } from "@intyr/chain";

/** The most a stock `x402Client` 2.28.0 pays without `spendControls`, in USDC atomic units. */
export const STOCK_CLIENT_MAX_ATOMIC = 1_000_000;
export const CHALLENGE_TAG = "x402-global-challenge";

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
  extensions?: { bazaar?: unknown };
}

export interface RouteProbe {
  method: "POST" | "GET";
  url: string;
  body?: unknown;
  /**
   * The probe names no real trip, so a trip-bound route must refuse with
   * `charged: false` before it issues a 402. A 402 here would charge for a
   * request that cannot succeed.
   */
  expectRefusalBeforeCharge?: boolean;
}

export type ChallengeProblem =
  | "NOT_402"
  | "CHARGES_BEFORE_TRIP_CHECK"
  | "NO_UNCHARGED_REFUSAL"
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
  | "MISSING_BAZAAR_DECLARATION";

export interface ChallengeCheck {
  url: string;
  status: number;
  ok: boolean;
  problems: ChallengeProblem[];
  /** True when the route refused before charging instead of issuing a 402. */
  refusedBeforeCharge?: boolean;
  amount?: string;
  payTo?: string;
}

function decodeHeader(value: string): PaymentRequired | null {
  try {
    const bin = atob(value);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as PaymentRequired;
  } catch {
    return null;
  }
}

/**
 * Calls a paid route without paying and checks the 402 it returns against
 * what the facilitator and a stock client need: x402 V2, an exact-scheme
 * Algorand accept with the full-hash CAIP-2 id, USDC, a price a stock client
 * will pay, one payTo, the challenge tag, a fee payer and a Bazaar declaration.
 */
export async function checkChallenge(
  probe: RouteProbe,
  expected: { network: "mainnet" | "testnet"; payTo?: string },
  fetchFn: FetchLike = fetch,
): Promise<ChallengeCheck> {
  const res = await fetchFn(probe.url, {
    method: probe.method,
    headers: { "content-type": "application/json" },
    ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
  });
  const base = { url: probe.url, status: res.status };
  if (probe.expectRefusalBeforeCharge) {
    if (res.status === 402) return { ...base, ok: false, problems: ["CHARGES_BEFORE_TRIP_CHECK"] };
    const body = (await res.json().catch(() => null)) as { charged?: unknown } | null;
    return res.status >= 400 && res.status < 500 && body?.charged === false
      ? { ...base, ok: true, problems: [], refusedBeforeCharge: true }
      : { ...base, ok: false, problems: ["NO_UNCHARGED_REFUSAL"] };
  }
  if (res.status !== 402) return { ...base, ok: false, problems: ["NOT_402"] };
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
  if (!required.extensions?.bazaar) problems.push("MISSING_BAZAAR_DECLARATION");

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
 * Reads `/.well-known/x402` and checks every paid route it lists, requiring
 * one payTo across all of them. `bodies` maps a route's last path segment to
 * a request body. A route without a body is probed with `{}` and must refuse
 * it before charging.
 */
export async function checkHostChallenges(
  host: string,
  network: "mainnet" | "testnet",
  bodies: Record<string, unknown>,
  fetchFn: FetchLike = fetch,
): Promise<{ payTo: string | null; checks: ChallengeCheck[] }> {
  const res = await fetchFn(`${host}/.well-known/x402`, { headers: { accept: "application/json" } });
  const doc = (res.ok ? await res.json() : { resources: [] }) as { resources?: DiscoveryResource[] };
  const caip2 = NETWORKS[network].caip2;
  const resources = (doc.resources ?? []).filter((r) => networkByCaip2(r.network)?.caip2 === caip2);
  const payTos = new Set(resources.map((r) => r.payTo));
  const payTo = payTos.size === 1 ? [...payTos][0]! : null;
  const checks = await Promise.all(
    resources.map((r) => {
      const path = new URL(r.url).pathname;
      const route = path.slice(path.lastIndexOf("/") + 1);
      const body = bodies[route];
      return checkChallenge(
        { method: r.method === "GET" ? "GET" : "POST", url: r.url, body: body ?? {}, expectRefusalBeforeCharge: body === undefined },
        { network, ...(payTo ? { payTo } : {}) },
        fetchFn,
      );
    }),
  );
  return { payTo, checks };
}
