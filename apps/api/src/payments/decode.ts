import algosdk from "algosdk";

/** Facts read out of the client's signed payment transaction before any money moves. */
export interface DecodedPayment {
  txid: string;
  sender: string;
  receiver: string;
  assetId: string;
  amount: string;
  firstValid: number;
  lastValid: number;
  groupSize: number;
  paymentIndex: number;
}

export class PaymentDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentDecodeError";
  }
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decodes the x402 exact-AVM payload (`paymentGroup` of base64 transactions and
 * `paymentIndex`). The txid is computed locally so it can be stored before the
 * facilitator is contacted: a lost settle response can then be resolved by
 * reading that txid from a node that is not the facilitator.
 */
export function decodeAvmPayment(payload: unknown): DecodedPayment {
  const p = payload as { paymentGroup?: unknown; paymentIndex?: unknown } | null;
  if (!p || !Array.isArray(p.paymentGroup) || typeof p.paymentIndex !== "number") {
    throw new PaymentDecodeError("payload must contain paymentGroup and paymentIndex");
  }
  const group = p.paymentGroup as unknown[];
  const index = p.paymentIndex;
  const entry = group[index];
  if (typeof entry !== "string") throw new PaymentDecodeError("paymentIndex does not point at a transaction");
  let stxn: algosdk.SignedTransaction;
  try {
    stxn = algosdk.decodeSignedTransaction(fromBase64(entry));
  } catch {
    throw new PaymentDecodeError("payment transaction is not a valid signed transaction");
  }
  const txn = stxn.txn;
  const xfer = txn.assetTransfer;
  if (!xfer) throw new PaymentDecodeError("payment transaction is not an asset transfer");
  return {
    txid: txn.txID(),
    sender: txn.sender.toString(),
    receiver: xfer.receiver.toString(),
    assetId: xfer.assetIndex.toString(),
    amount: xfer.amount.toString(),
    firstValid: Number(txn.firstValid),
    lastValid: Number(txn.lastValid),
    groupSize: group.length,
    paymentIndex: index,
  };
}
