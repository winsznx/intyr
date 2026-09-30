import algosdk from "algosdk";
import { RejectedError, getSuggestedParams, submitSigned } from "./algod";
import type { AnchorRef } from "@intyr/core";
import type { NetworkConfig } from "./config";
import type { TripStore } from "./domain/store";
import { updateTripDoc } from "./domain/service/trip-update";

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

/**
 * Records a manifest hash on Algorand as the note of a 0-ALGO payment from the anchor account to itself.
 * The transaction proves integrity and timing of the manifest, not that any supplier told the truth.
 * The txid is returned as soon as the transaction is accepted; confirmation is awaited briefly and otherwise left PENDING.
 */
export async function anchorHash(signer: AnchorSigner, manifestId: string, manifestHash: string, store?: TripStore): Promise<AnchorRef & { state: "CONFIRMED" | "PENDING" }> {
  const fetchFn = signer.fetchFn ?? fetch;
  const sleep = signer.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const account = algosdk.mnemonicToSecretKey(signer.mnemonic);
  const suggestedParams = await getSuggestedParams(signer.net, fetchFn);
  const note = noteFor(manifestHash);
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note: new TextEncoder().encode(note),
    suggestedParams,
  });
  const txid = txn.txID();
  const now = new Date().toISOString();
  await store?.putAnchor({ manifest_id: manifestId, network: signer.net.name, mode: "SEPARATE_NOTE_TRANSACTION", txid, state: "SUBMITTED", now });
  try {
    await submitSigned(signer.net, txn.signTxn(account.sk), fetchFn);
  } catch (e) {
    if (e instanceof RejectedError) await store?.updateAnchor(manifestId, { state: "FAILED", error: e.message, now: new Date().toISOString() });
    throw new Error(`anchor submit failed: ${e instanceof Error ? e.message : String(e)}`);
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

/** A transaction is valid for about 47 minutes, so one that is still unseen an hour later can never confirm. */
const ANCHOR_EXPIRY_MS = 60 * 60_000;

/** Mirrors a settled anchor into the trip document that shows it, so a trip never keeps reading PENDING. */
async function syncTripAnchor(store: TripStore, manifestId: string, txid: string, state: "CONFIRMED" | "FAILED", now: string): Promise<void> {
  const manifest = await store.getManifest(manifestId);
  if (!manifest?.trip_id) return;
  await updateTripDoc(store, manifest.trip_id, now, (doc) => {
    if (doc.manifest_id !== manifestId && doc.final_manifest_id !== manifestId) return;
    doc.anchor = { state, txid, mode: doc.anchor?.mode ?? "SEPARATE_NOTE_TRANSACTION" };
  });
}

/**
 * Cron step: settles anchors that were submitted but not seen in a block when their request ended. Each poll touches
 * the row so a stuck anchor cannot starve newer ones, and an anchor unseen past its validity window is marked FAILED.
 */
export async function reconcileAnchors(store: TripStore, net: NetworkConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<number> {
  const pending = (await store.listPendingAnchors(20)).filter((a) => a.network === net.name);
  let settled = 0;
  for (const a of pending) {
    const round = await confirmedRound(net, a.txid, fetchFn);
    if (round !== null) {
      await store.updateAnchor(a.manifest_id, { state: "CONFIRMED", round, now: now.toISOString() });
      await syncTripAnchor(store, a.manifest_id, a.txid, "CONFIRMED", now.toISOString());
      settled++;
    } else if (now.getTime() - Date.parse(a.created_at) > ANCHOR_EXPIRY_MS) {
      await store.updateAnchor(a.manifest_id, { state: "FAILED", error: "not seen on chain within its validity window", now: now.toISOString() });
      await syncTripAnchor(store, a.manifest_id, a.txid, "FAILED", now.toISOString());
      settled++;
    } else {
      await store.updateAnchor(a.manifest_id, { state: "PENDING", now: now.toISOString() });
    }
  }
  return settled;
}
