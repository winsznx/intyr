import algosdk from "algosdk";
import { asNumber, asRecord, base64ToBytes, getJson, type FetchLike } from "./http";
import type { ChainEndpoints } from "./networks";
import { manifestAnchorNote } from "./note";

export type TxLookup =
  | { state: "CONFIRMED"; round: number; source: "algod" | "indexer" }
  /** In the node's pool and not yet in a block. */
  | { state: "PENDING" }
  /** The node evicted it from the pool with an error. It will never confirm. */
  | { state: "DROPPED"; reason: string }
  /** Neither node nor indexer knows it. Final only once `currentRound` is past the transaction's last valid round. */
  | { state: "NOT_FOUND"; currentRound: number | null }
  | { state: "UNAVAILABLE"; reason: string };

async function currentRound(net: ChainEndpoints, fetchFn: FetchLike): Promise<number | null> {
  const res = await getJson(fetchFn, `${net.algodUrl}/v2/status`);
  return res.kind === "ok" ? (asNumber(asRecord(res.body)["last-round"]) ?? null) : null;
}

/** Confirmation state of a txid: the node's pending pool first (no indexing lag), then the indexer. */
export async function lookupTransaction(net: ChainEndpoints, txid: string, fetchFn: FetchLike = fetch): Promise<TxLookup> {
  const pending = await getJson(fetchFn, `${net.algodUrl}/v2/transactions/pending/${encodeURIComponent(txid)}`);
  if (pending.kind === "ok") {
    const body = asRecord(pending.body);
    const round = asNumber(body["confirmed-round"]);
    if (round !== undefined && round > 0) return { state: "CONFIRMED", round, source: "algod" };
    const poolError = body["pool-error"];
    if (typeof poolError === "string" && poolError.length > 0) return { state: "DROPPED", reason: poolError };
    return { state: "PENDING" };
  }
  const indexed = await getJson(fetchFn, `${net.indexerUrl}/v2/transactions/${encodeURIComponent(txid)}`);
  if (indexed.kind === "ok") {
    const round = asNumber(asRecord(asRecord(indexed.body)["transaction"])["confirmed-round"]);
    if (round !== undefined && round > 0) return { state: "CONFIRMED", round, source: "indexer" };
  }
  if (pending.kind === "error" && indexed.kind === "error") return { state: "UNAVAILABLE", reason: indexed.reason };
  return { state: "NOT_FOUND", currentRound: await currentRound(net, fetchFn) };
}

export async function confirmedRound(net: ChainEndpoints, txid: string, fetchFn: FetchLike = fetch): Promise<number | null> {
  const lookup = await lookupTransaction(net, txid, fetchFn);
  return lookup.state === "CONFIRMED" ? lookup.round : null;
}

export interface IndexedTransaction {
  txid: string;
  round: number;
  sender: string;
  txType: string;
  note: string | null;
  group: string | null;
  payment: { receiver: string; amount: number } | null;
  assetTransfer: { receiver: string; assetId: number; amount: number } | null;
}

export type IndexedRead =
  | { state: "FOUND"; tx: IndexedTransaction }
  | { state: "NOT_FOUND" }
  | { state: "UNAVAILABLE"; reason: string };

function decodeNote(b64: unknown): string | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(b64));
  } catch {
    return null;
  }
}

function parseIndexed(txid: string, raw: Record<string, unknown>): IndexedTransaction | null {
  const round = asNumber(raw["confirmed-round"]);
  if (round === undefined || typeof raw["sender"] !== "string") return null;
  const pay = asRecord(raw["payment-transaction"]);
  const axfer = asRecord(raw["asset-transfer-transaction"]);
  const payAmount = asNumber(pay["amount"]);
  const axferAsset = asNumber(axfer["asset-id"]);
  const axferAmount = asNumber(axfer["amount"]);
  return {
    txid: typeof raw["id"] === "string" ? raw["id"] : txid,
    round,
    sender: raw["sender"],
    txType: typeof raw["tx-type"] === "string" ? raw["tx-type"] : "unknown",
    note: decodeNote(raw["note"]),
    group: typeof raw["group"] === "string" ? raw["group"] : null,
    payment: typeof pay["receiver"] === "string" && payAmount !== undefined ? { receiver: pay["receiver"], amount: payAmount } : null,
    assetTransfer:
      typeof axfer["receiver"] === "string" && axferAsset !== undefined && axferAmount !== undefined
        ? { receiver: axfer["receiver"], assetId: axferAsset, amount: axferAmount }
        : null,
  };
}

/** Reads a confirmed transaction from the indexer, the public record anyone can query without Intyr. */
export async function readIndexedTransaction(net: ChainEndpoints, txid: string, fetchFn: FetchLike = fetch): Promise<IndexedRead> {
  const res = await getJson(fetchFn, `${net.indexerUrl}/v2/transactions/${encodeURIComponent(txid)}`);
  if (res.kind === "not_found") return { state: "NOT_FOUND" };
  if (res.kind === "error") return { state: "UNAVAILABLE", reason: res.reason };
  const tx = parseIndexed(txid, asRecord(asRecord(res.body)["transaction"]));
  return tx ? { state: "FOUND", tx } : { state: "NOT_FOUND" };
}

export type AnchorCheck =
  | { state: "ANCHOR_CONFIRMED"; txid: string; round: number; sender: string }
  | { state: "ANCHOR_UNCONFIRMED"; txid: string }
  | { state: "ANCHOR_NOT_FOUND"; txid: string }
  | { state: "HASH_MISMATCH"; txid: string; note: string | null }
  | { state: "ANCHOR_WRONG_SENDER"; txid: string; sender: string }
  | { state: "INDEXER_UNAVAILABLE"; reason: string };

/**
 * Checks that `txid` is a confirmed transaction whose note is the anchor note
 * of `manifestHash`, sent by the published anchor account when one is given.
 * An anchor proves the manifest existed unchanged at that round. It says
 * nothing about whether a supplier told the truth.
 */
export async function checkManifestAnchor(
  net: ChainEndpoints,
  txid: string,
  manifestHash: string,
  options: { anchorAddress?: string; fetch?: FetchLike } = {},
): Promise<AnchorCheck> {
  const fetchFn = options.fetch ?? fetch;
  const read = await readIndexedTransaction(net, txid, fetchFn);
  if (read.state === "UNAVAILABLE") return { state: "INDEXER_UNAVAILABLE", reason: read.reason };
  if (read.state === "NOT_FOUND") {
    const lookup = await lookupTransaction(net, txid, fetchFn);
    return lookup.state === "PENDING" || lookup.state === "CONFIRMED" ? { state: "ANCHOR_UNCONFIRMED", txid } : { state: "ANCHOR_NOT_FOUND", txid };
  }
  const { tx } = read;
  if (tx.note !== manifestAnchorNote(manifestHash)) return { state: "HASH_MISMATCH", txid, note: tx.note };
  if (options.anchorAddress !== undefined && tx.sender !== options.anchorAddress) {
    return { state: "ANCHOR_WRONG_SENDER", txid, sender: tx.sender };
  }
  return { state: "ANCHOR_CONFIRMED", txid, round: tx.round, sender: tx.sender };
}

export interface AssetTransfer {
  txid: string;
  round: number;
  sender: string;
  receiver: string;
  assetId: number;
  amount: number;
  group: string | null;
  source: "indexer" | "algod";
}

export type AssetTransferRead =
  | { state: "CONFIRMED"; transfer: AssetTransfer }
  | { state: "NOT_A_TRANSFER"; txType: string }
  | { state: "PENDING" }
  | { state: "NOT_FOUND"; currentRound: number | null }
  | { state: "UNAVAILABLE"; reason: string };

function algodAddress(b64: unknown): string | null {
  return typeof b64 === "string" && b64.length > 0 ? algosdk.encodeAddress(base64ToBytes(b64)) : null;
}

/** Reads an ASA transfer by txid: indexer first, then the node's pending pool to cover indexing lag. */
export async function readAssetTransfer(net: ChainEndpoints, txid: string, fetchFn: FetchLike = fetch): Promise<AssetTransferRead> {
  const indexed = await readIndexedTransaction(net, txid, fetchFn);
  if (indexed.state === "FOUND") {
    const { tx } = indexed;
    if (!tx.assetTransfer) return { state: "NOT_A_TRANSFER", txType: tx.txType };
    return {
      state: "CONFIRMED",
      transfer: { txid: tx.txid, round: tx.round, sender: tx.sender, ...tx.assetTransfer, group: tx.group, source: "indexer" },
    };
  }
  const pending = await getJson(fetchFn, `${net.algodUrl}/v2/transactions/pending/${encodeURIComponent(txid)}`);
  if (pending.kind === "ok") {
    const body = asRecord(pending.body);
    const round = asNumber(body["confirmed-round"]);
    if (round === undefined || round === 0) return { state: "PENDING" };
    const raw = asRecord(asRecord(body["txn"])["txn"]);
    const sender = algodAddress(raw["snd"]);
    const receiver = algodAddress(raw["arcv"]);
    const assetId = asNumber(raw["xaid"]);
    if (raw["type"] !== "axfer" || !sender || !receiver || assetId === undefined) {
      return { state: "NOT_A_TRANSFER", txType: typeof raw["type"] === "string" ? raw["type"] : "unknown" };
    }
    const group = typeof raw["grp"] === "string" ? raw["grp"] : null;
    return {
      state: "CONFIRMED",
      transfer: { txid, round, sender, receiver, assetId, amount: asNumber(raw["aamt"]) ?? 0, group, source: "algod" },
    };
  }
  if (indexed.state === "UNAVAILABLE" && pending.kind === "error") return { state: "UNAVAILABLE", reason: indexed.reason };
  return { state: "NOT_FOUND", currentRound: await currentRound(net, fetchFn) };
}

export type TransferCheck =
  | { ok: true }
  | { ok: false; reason: "WRONG_ASSET" | "WRONG_RECEIVER" | "WRONG_AMOUNT" | "WRONG_SENDER" };

/** Compares a confirmed transfer with what the payment was bound to. */
export function matchTransfer(
  transfer: AssetTransfer,
  expected: { assetId: number; receiver: string; amount: number; sender?: string },
): TransferCheck {
  if (transfer.assetId !== expected.assetId) return { ok: false, reason: "WRONG_ASSET" };
  if (transfer.receiver !== expected.receiver) return { ok: false, reason: "WRONG_RECEIVER" };
  if (transfer.amount !== expected.amount) return { ok: false, reason: "WRONG_AMOUNT" };
  if (expected.sender !== undefined && transfer.sender !== expected.sender) return { ok: false, reason: "WRONG_SENDER" };
  return { ok: true };
}
