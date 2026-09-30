import type { SuggestedParams } from "algosdk";
import type { NetworkConfig } from "./config";

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
  if (res.status >= 400 && res.status < 500) throw new RejectedError(res.status, detail);
  throw new Error(`algod unavailable: ${res.status} ${detail}`);
}
