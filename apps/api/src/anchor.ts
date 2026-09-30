import algosdk from "algosdk";
import type { AnchorRef } from "@intyr/core";
import type { NetworkConfig } from "./config";
import type { TripStore } from "./domain/store";

export const ANCHOR_NOTE_PREFIX = "intyr:v1:";

export interface AnchorSigner {
  net: NetworkConfig;
  /** 25-word mnemonic of the small hot ALGO account that pays the 0.001 ALGO anchor fee. */
  mnemonic: string;
  fetchFn?: typeof fetch;
  /** How long to wait for confirmation before leaving the anchor PENDING. */
  confirmWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function noteFor(manifestHash: string): string {
  return ANCHOR_NOTE_PREFIX + manifestHash.replace(/^sha256:/, "");
}

interface TxParams {
  fee: number;
  minFee: number;
  firstValid: number;
  lastValid: number;
  genesisID: string;
  genesisHash: string;
}

async function getParams(net: NetworkConfig, fetchFn: typeof fetch): Promise<TxParams> {
  const res = await fetchFn(`${net.algodUrl}/v2/transactions/params`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`algod params ${res.status}`);
  const p = (await res.json()) as Record<string, unknown>;
  return {
    fee: Number(p["fee"] ?? 0),
    minFee: Number(p["min-fee"] ?? 1000),
    firstValid: Number(p["last-round"]),
    lastValid: Number(p["last-round"]) + 1000,
    genesisID: String(p["genesis-id"]),
    genesisHash: String(p["genesis-hash"]),
  };
}

/**
 * Records a manifest hash on Algorand as the note of a 0-ALGO payment from the anchor account to itself.
 * The transaction proves integrity and timing of the manifest, not that any supplier told the truth.
 * The txid is returned as soon as the transaction is accepted; confirmation is awaited briefly and otherwise left PENDING.
 */
export async function anchorHash(signer: AnchorSigner, manifestId: string, manifestHash: string, store?: TripStore): Promise<AnchorRef & { state: "CONFIRMED" | "PENDING" }> {
  const fetchFn = signer.fetchFn ?? fetch;
  const sleep = signer.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const account = algosdk.mnemonicToSecretKey(signer.mnemonic);
  const params = await getParams(signer.net, fetchFn);
  const note = noteFor(manifestHash);
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note: new TextEncoder().encode(note),
    suggestedParams: {
      fee: params.fee,
      flatFee: false,
      minFee: params.minFee,
      firstValid: params.firstValid,
      lastValid: params.lastValid,
      genesisID: params.genesisID,
      genesisHash: Uint8Array.from(atob(params.genesisHash), (c) => c.charCodeAt(0)),
    },
  });
  const txid = txn.txID();
  const now = new Date().toISOString();
  await store?.putAnchor({ manifest_id: manifestId, network: signer.net.name, mode: "SEPARATE_NOTE_TRANSACTION", txid, state: "SUBMITTED", now });
  const signed = txn.signTxn(account.sk);
  const res = await fetchFn(`${signer.net.algodUrl}/v2/transactions`, { method: "POST", headers: { "content-type": "application/x-binary" }, body: signed });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    await store?.updateAnchor(manifestId, { state: "FAILED", error: detail, now: new Date().toISOString() });
    throw new Error(`anchor submit failed: ${res.status} ${detail}`);
  }
  const deadline = Date.now() + (signer.confirmWaitMs ?? 6000);
  for (;;) {
    const round = await confirmedRound(signer.net, txid, fetchFn, { indexer: false });
    if (round !== null) {
      await store?.updateAnchor(manifestId, { state: "CONFIRMED", round, now: new Date().toISOString() });
      return { mode: "SEPARATE_NOTE_TRANSACTION", network: signer.net.caip2, txid, confirmed_round: round, note_prefix: ANCHOR_NOTE_PREFIX, state: "CONFIRMED" };
    }
    if (Date.now() >= deadline) break;
    await sleep(1000);
  }
  await store?.updateAnchor(manifestId, { state: "PENDING", now: new Date().toISOString() });
  return { mode: "SEPARATE_NOTE_TRANSACTION", network: signer.net.caip2, txid, note_prefix: ANCHOR_NOTE_PREFIX, state: "PENDING" };
}

/** Confirmed round of a transaction, or null when it is not (yet) in a block. */
export async function confirmedRound(net: NetworkConfig, txid: string, fetchFn: typeof fetch = fetch, opts: { indexer?: boolean } = {}): Promise<number | null> {
  try {
    const res = await fetchFn(`${net.algodUrl}/v2/transactions/pending/${txid}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const t = (await res.json()) as { "confirmed-round"?: number };
      if (typeof t["confirmed-round"] === "number" && t["confirmed-round"] > 0) return t["confirmed-round"];
    }
    if (opts.indexer === false) return null;
    const idx = await fetchFn(`${net.indexerUrl}/v2/transactions/${txid}`, { headers: { accept: "application/json" } });
    if (idx.ok) {
      const t = (await idx.json()) as { transaction?: { "confirmed-round"?: number } };
      const round = t.transaction?.["confirmed-round"];
      if (typeof round === "number" && round > 0) return round;
    }
  } catch {
    return null;
  }
  return null;
}

export type AnchorCheck =
  | { state: "ANCHOR_CONFIRMED"; round: number; txid: string }
  | { state: "ANCHOR_UNCONFIRMED"; txid: string }
  | { state: "ANCHOR_NOT_FOUND" }
  | { state: "INDEXER_UNAVAILABLE" }
  | { state: "HASH_MISMATCH"; txid: string };

/** Reads the anchor transaction from a public indexer and checks that its note carries the manifest hash. */
export async function checkAnchor(net: NetworkConfig, txid: string | null, manifestHash: string, fetchFn: typeof fetch = fetch): Promise<AnchorCheck> {
  if (!txid) return { state: "ANCHOR_NOT_FOUND" };
  try {
    const res = await fetchFn(`${net.indexerUrl}/v2/transactions/${txid}`, { headers: { accept: "application/json" } });
    if (res.status === 404) return { state: "ANCHOR_UNCONFIRMED", txid };
    if (!res.ok) return { state: "INDEXER_UNAVAILABLE" };
    const body = (await res.json()) as { transaction?: { note?: string; "confirmed-round"?: number } };
    const t = body.transaction;
    if (!t || typeof t["confirmed-round"] !== "number") return { state: "ANCHOR_UNCONFIRMED", txid };
    const note = t.note ? atob(t.note) : "";
    return note === noteFor(manifestHash) ? { state: "ANCHOR_CONFIRMED", round: t["confirmed-round"], txid } : { state: "HASH_MISMATCH", txid };
  } catch {
    return { state: "INDEXER_UNAVAILABLE" };
  }
}

/**
 * Cron step: settles anchors that were submitted but not seen in a block when their request ended.
 * An anchor that is still absent long after its validity window is marked FAILED so it stops being polled.
 */
export async function reconcileAnchors(store: TripStore, net: NetworkConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<number> {
  const pending = (await store.listPendingAnchors(20)).filter((a) => a.network === net.name);
  let settled = 0;
  for (const a of pending) {
    const round = await confirmedRound(net, a.txid, fetchFn);
    if (round !== null) {
      await store.updateAnchor(a.manifest_id, { state: "CONFIRMED", round, now: now.toISOString() });
      settled++;
    }
  }
  return settled;
}
