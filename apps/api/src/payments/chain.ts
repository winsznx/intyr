import algosdk from "algosdk";
import { chainFetch } from "../algod";
import type { NetworkConfig } from "../config";

/** What an independent node says about a payment transaction. */
export type ChainReading =
  | { status: "confirmed"; round: number; sender: string; receiver: string; assetId: string; amount: string }
  | { status: "absent"; currentRound: number }
  | { status: "unavailable"; reason: string };

interface IndexerTxn {
  "confirmed-round"?: number;
  sender?: string;
  "asset-transfer-transaction"?: { amount?: number | string; "asset-id"?: number | string; receiver?: string };
}

/**
 * Reads a transaction by id from the indexer, then falls back to the algod
 * pending-transaction endpoint (no indexing lag). `absent` is only conclusive
 * once the caller has compared `currentRound` against the transaction's last valid round.
 */
export async function readPaymentTx(
  net: NetworkConfig,
  txid: string,
  fetchFn: typeof fetch = chainFetch,
): Promise<ChainReading> {
  try {
    const res = await fetchFn(`${net.indexerUrl}/v2/transactions/${txid}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { transaction?: IndexerTxn };
      const t = body.transaction;
      const x = t?.["asset-transfer-transaction"];
      if (t && typeof t["confirmed-round"] === "number" && x) {
        return {
          status: "confirmed",
          round: t["confirmed-round"],
          sender: String(t.sender),
          receiver: String(x.receiver),
          assetId: String(x["asset-id"]),
          amount: String(x.amount),
        };
      }
    }
  } catch {
    // fall through to algod
  }
  try {
    const res = await fetchFn(`${net.algodUrl}/v2/transactions/pending/${txid}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const t = (await res.json()) as {
        "confirmed-round"?: number;
        txn?: { txn?: { snd?: string; arcv?: string; xaid?: number; aamt?: number } };
      };
      if (typeof t["confirmed-round"] === "number" && t["confirmed-round"] > 0 && t.txn?.txn) {
        const raw = t.txn.txn;
        const addr = (b64?: string) => (b64 ? algosdk.encodeAddress(b64ToBytes(b64)) : "");
        return {
          status: "confirmed",
          round: t["confirmed-round"],
          sender: addr(raw.snd),
          receiver: addr(raw.arcv),
          assetId: String(raw.xaid ?? ""),
          amount: String(raw.aamt ?? ""),
        };
      }
    }
    const st = await fetchFn(`${net.algodUrl}/v2/status`, { headers: { accept: "application/json" } });
    if (st.ok) {
      const s = (await st.json()) as { "last-round"?: number };
      return { status: "absent", currentRound: Number(s["last-round"] ?? 0) };
    }
    return { status: "unavailable", reason: `algod status ${st.status}` };
  } catch (e) {
    return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}

function b64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
