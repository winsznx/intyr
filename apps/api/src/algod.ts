import type { SuggestedParams } from "algosdk";
import type { NetworkConfig } from "./config";

const PRIMARY_SUFFIX = ".4160.nodely.dev";
const SECONDARY_SUFFIX = ".algonode.cloud";

/** The same node family on its other public domain. Custom node URLs have no alternate. */
function alternateUrl(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith(PRIMARY_SUFFIX)) parsed.hostname = parsed.hostname.slice(0, -PRIMARY_SUFFIX.length) + SECONDARY_SUFFIX;
  else if (parsed.hostname.endsWith(SECONDARY_SUFFIX)) parsed.hostname = parsed.hostname.slice(0, -SECONDARY_SUFFIX.length) + PRIMARY_SUFFIX;
  else return null;
  return parsed.toString();
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * fetch for public Algorand nodes. The free tier counts requests per egress address and a Worker shares its address with
 * other tenants, so a quota or overload answer (403, 429, 5xx) or a network error retries once on the node's other domain.
 * A request that has a body is a signed transaction, which is safe to send twice.
 */
export const chainFetch: typeof fetch = async (input, init) => {
  const url = urlOf(input);
  let first: Response | null = null;
  try {
    first = await globalThis.fetch(input, init);
    if (first.status !== 403 && first.status !== 429 && first.status < 500) return first;
  } catch (e) {
    if (!alternateUrl(url)) throw e;
  }
  const alternate = alternateUrl(url);
  if (!alternate) return first!;
  try {
    const second = await globalThis.fetch(alternate, init);
    if (second.status < 400 || !first) return second;
    return first;
  } catch (e) {
    if (first) return first;
    throw e;
  }
};

function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Suggested transaction parameters from algod. The fee is the per-byte rate, which is 0 unless the network is
 * congested, so the transaction must not be flat-fee: algosdk raises it to the network minimum only then.
 */
export async function getSuggestedParams(net: NetworkConfig, fetchFn: typeof fetch): Promise<SuggestedParams> {
  const res = await fetchFn(`${net.algodUrl}/v2/transactions/params`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`algod params ${res.status}`);
  const p = (await res.json()) as Record<string, unknown>;
  const lastRound = Number(p["last-round"]);
  return {
    fee: Number(p["fee"] ?? 0),
    flatFee: false,
    minFee: Number(p["min-fee"] ?? 1000),
    firstValid: lastRound,
    lastValid: lastRound + 1000,
    genesisID: String(p["genesis-id"]),
    genesisHash: base64ToBytes(String(p["genesis-hash"])),
  };
}

/** Submits a signed transaction. A 4xx from algod is a definitive rejection and throws RejectedError. */
export class RejectedError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`algod rejected the transaction: ${status} ${detail}`);
    this.name = "RejectedError";
  }
}

export async function submitSigned(net: NetworkConfig, signed: Uint8Array, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`${net.algodUrl}/v2/transactions`, { method: "POST", headers: { "content-type": "application/x-binary" }, body: signed });
  if (res.ok) return;
  const detail = (await res.text()).slice(0, 300);
  // A retry can find the first send already accepted, which is success.
  if (/already in (the )?ledger/i.test(detail)) return;
  // Quota and rate limit answers say nothing about the transaction, so they are not a rejection.
  if (res.status >= 400 && res.status < 500 && res.status !== 403 && res.status !== 429) throw new RejectedError(res.status, detail);
  throw new Error(`algod unavailable: ${res.status} ${detail}`);
}
