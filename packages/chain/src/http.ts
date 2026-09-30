import type { ChainEndpoints } from "./networks";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A node answer that means "not now" rather than "no": a quota, a rate limit or a server fault. */
export function isUnavailable(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/**
 * Sends a request that fails for availability reasons once more to the
 * fallback node. Free public tiers meter per egress address, which a Worker
 * shares with other tenants. Resending the same signed transaction bytes is
 * safe because Algorand accepts a txid only once.
 */
export function failoverFetch(net: ChainEndpoints, fetchFn: FetchLike): FetchLike {
  const fallback = net.fallback;
  if (!fallback) return fetchFn;
  const alternate = (url: string): string | null => {
    if (url.startsWith(net.algodUrl)) return fallback.algodUrl + url.slice(net.algodUrl.length);
    if (url.startsWith(net.indexerUrl)) return fallback.indexerUrl + url.slice(net.indexerUrl.length);
    return null;
  };
  return async (url, init) => {
    const other = alternate(url);
    if (!other) return fetchFn(url, init);
    const primary = await fetchFn(url, init).then(
      (res) => (isUnavailable(res.status) ? null : res),
      () => null,
    );
    return primary ?? fetchFn(other, init);
  };
}

export type JsonResponse =
  | { kind: "ok"; body: unknown }
  | { kind: "not_found" }
  | { kind: "error"; reason: string };

/** GETs JSON from an algod or indexer endpoint. Network failures become data, never throws. */
export async function getJson(fetchFn: FetchLike, url: string): Promise<JsonResponse> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", reason: `${url} answered ${res.status}` };
    return { kind: "ok", body: await res.json() };
  } catch (e) {
    return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
