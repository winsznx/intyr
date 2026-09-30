import algosdk from "algosdk";
import { asNumber, asRecord, base64ToBytes, failoverFetch, getJson, type FetchLike } from "./http";
import type { ChainEndpoints } from "./networks";
import { MAX_NOTE_BYTES } from "./note";

/** Nothing was sent: the node could not be reached before a transaction existed. Safe to retry. */
export class ChainUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`algod unavailable: ${reason}`);
    this.name = "ChainUnavailableError";
  }
}

export interface PreparedNote {
  /** Known before sending, so a caller can persist it first and reconcile by it after a lost response. */
  txid: string;
  sender: string;
  firstValid: number;
  lastValid: number;
  fee: number;
  signed: Uint8Array;
}

export type SubmitResult =
  | ({ state: "ACCEPTED" } & Omit<PreparedNote, "signed">)
  /** The response was lost or the node failed: the transaction may or may not be in the pool. Read the txid before resending. */
  | ({ state: "UNKNOWN"; reason: string } & Omit<PreparedNote, "signed">)
  /** The node refused the transaction. It can never confirm. */
  | ({ state: "REJECTED"; status: number; reason: string } & Omit<PreparedNote, "signed">);

export interface NoteOptions {
  fetch?: FetchLike;
  /** Rounds the transaction stays valid for. At about 2.8 s per round, 100 rounds is under five minutes. */
  validRounds?: number;
}

interface NodeParams {
  fee: number;
  minFee: number;
  lastRound: number;
  genesisId: string;
  genesisHash: string;
}

async function nodeParams(net: ChainEndpoints, fetchFn: FetchLike): Promise<NodeParams> {
  const res = await getJson(fetchFn, `${net.algodUrl}/v2/transactions/params`);
  if (res.kind !== "ok") throw new ChainUnavailableError(res.kind === "error" ? res.reason : "params not found");
  const p = asRecord(res.body);
  const lastRound = asNumber(p["last-round"]);
  const genesisId = p["genesis-id"];
  const genesisHash = p["genesis-hash"];
  if (lastRound === undefined || typeof genesisId !== "string" || typeof genesisHash !== "string") {
    throw new ChainUnavailableError("params response is missing last-round or genesis fields");
  }
  return { fee: asNumber(p["fee"]) ?? 0, minFee: asNumber(p["min-fee"]) ?? 1000, lastRound, genesisId, genesisHash };
}

/**
 * Builds and signs a 0-ALGO payment from the signer to itself carrying `note`.
 * The fee is computed per byte with the node's minimum as the floor: algosdk
 * raises a fee to the minimum only when it is not flat.
 */
export async function prepareNoteTransaction(
  net: ChainEndpoints,
  signer: { mnemonic: string },
  note: string,
  options: NoteOptions = {},
): Promise<PreparedNote> {
  const noteBytes = new TextEncoder().encode(note);
  if (noteBytes.length > MAX_NOTE_BYTES) throw new RangeError(`note is ${noteBytes.length} bytes, the limit is ${MAX_NOTE_BYTES}`);
  const account = algosdk.mnemonicToSecretKey(signer.mnemonic);
  const params = await nodeParams(net, failoverFetch(net, options.fetch ?? fetch));
  const firstValid = params.lastRound;
  const lastValid = params.lastRound + (options.validRounds ?? 100);
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note: noteBytes,
    suggestedParams: {
      fee: params.fee,
      minFee: params.minFee,
      flatFee: false,
      firstValid,
      lastValid,
      genesisID: params.genesisId,
      genesisHash: base64ToBytes(params.genesisHash),
    },
  });
  return {
    txid: txn.txID(),
    sender: account.addr.toString(),
    firstValid,
    lastValid,
    fee: Number(txn.fee),
    signed: txn.signTxn(account.sk),
  };
}

/** Sends a prepared transaction. A lost response is UNKNOWN, never a failure that invites a blind resend. */
export async function sendPreparedTransaction(
  net: ChainEndpoints,
  prepared: PreparedNote,
  options: Pick<NoteOptions, "fetch"> = {},
): Promise<SubmitResult> {
  const { signed, ...ref } = prepared;
  const fetchFn = failoverFetch(net, options.fetch ?? fetch);
  let res: Response;
  try {
    res = await fetchFn(`${net.algodUrl}/v2/transactions`, {
      method: "POST",
      headers: { "content-type": "application/x-binary" },
      body: signed as BodyInit,
    });
  } catch (e) {
    return { state: "UNKNOWN", reason: e instanceof Error ? e.message : String(e), ...ref };
  }
  if (res.ok) return { state: "ACCEPTED", ...ref };
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  // Only a 400 is algod judging the transaction. A quota, rate limit or server fault never looked at it.
  if (res.status === 400) return { state: "REJECTED", status: res.status, reason: detail, ...ref };
  return { state: "UNKNOWN", reason: `algod answered ${res.status}: ${detail}`, ...ref };
}

/** Prepare and send in one step, for callers that do not persist the txid first. */
export async function submitNoteTransaction(
  net: ChainEndpoints,
  signer: { mnemonic: string },
  note: string,
  options: NoteOptions = {},
): Promise<SubmitResult> {
  return sendPreparedTransaction(net, await prepareNoteTransaction(net, signer, note, options), options);
}
