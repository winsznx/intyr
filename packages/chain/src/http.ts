export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
