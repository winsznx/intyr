import algosdk from "algosdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";

export const TESTNET_GENESIS_ID = "testnet-v1.0";
export const TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const FEE_PAYER = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
export const USDC_TESTNET = 10458941;

export const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", extra: { feePayer: FEE_PAYER } },
    { x402Version: 2, scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", extra: { feePayer: FEE_PAYER } },
  ],
  extensions: [],
  signers: { "algorand:*": [FEE_PAYER] },
};

export interface FakeFacilitator extends FacilitatorClient {
  calls: { verify: number; settle: number };
  mode: { settle: "ok" | "throw" | "fail"; verify: "ok" | "invalid" };
}

export function fakeFacilitator(): FakeFacilitator {
  const f: FakeFacilitator = {
    calls: { verify: 0, settle: 0 },
    mode: { settle: "ok", verify: "ok" },
    async getSupported() {
      return SUPPORTED as never;
    },
    async verify(payload) {
      f.calls.verify++;
      if (f.mode.verify === "invalid") return { isValid: false, invalidReason: "invalid_payload" } as never;
      return { isValid: true, payer: senderOf(payload) } as never;
    },
    async settle(payload, requirements) {
      f.calls.settle++;
      if (f.mode.settle === "throw") throw new Error("facilitator connection dropped");
      if (f.mode.settle === "fail") return { success: false, errorReason: "transaction_failed", transaction: "", network: requirements.network, payer: senderOf(payload) } as never;
      return { success: true, transaction: txidOf(payload), network: requirements.network, payer: senderOf(payload) } as never;
    },
  };
  return f;
}

function paymentTxn(payload: { payload: { paymentGroup: string[]; paymentIndex: number } }): algosdk.Transaction {
  const raw = Uint8Array.from(atob(payload.payload.paymentGroup[payload.payload.paymentIndex]!), (c) => c.charCodeAt(0));
  return algosdk.decodeSignedTransaction(raw).txn;
}
export function txidOf(payload: unknown): string {
  return paymentTxn(payload as never).txID();
}
export function senderOf(payload: unknown): string {
  return paymentTxn(payload as never).sender.toString();
}

export interface Payer {
  addr: string;
  sk: Uint8Array;
}
export function newPayer(): Payer {
  const a = algosdk.generateAccount();
  return { addr: a.addr.toString(), sk: a.sk };
}

/**
 * Builds what a stock x402 AVM client sends: a group of [unsigned fee payer txn, signed USDC transfer],
 * with paymentIndex pointing at the transfer.
 */
export function buildPaymentHeader(opts: {
  payer: Payer;
  requirements: Record<string, unknown>;
  resourceUrl: string;
  firstValid?: number;
  lastValid?: number;
  amount?: string;
  note?: string;
}): { header: string; txid: string } {
  const req = opts.requirements as { payTo: string; amount: string; asset: string };
  const firstValid = opts.firstValid ?? 1000;
  const lastValid = opts.lastValid ?? 2000;
  const params = {
    fee: 0,
    flatFee: true,
    firstValid,
    lastValid,
    genesisID: TESTNET_GENESIS_ID,
    genesisHash: Uint8Array.from(atob(TESTNET_GENESIS_HASH), (c) => c.charCodeAt(0)),
    minFee: 1000,
  };
  const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: FEE_PAYER, receiver: FEE_PAYER, amount: 0, suggestedParams: { ...params, fee: 2000 }, note: new TextEncoder().encode("x402-fee-payer") });
  const xfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: opts.payer.addr,
    receiver: req.payTo,
    assetIndex: Number(req.asset),
    amount: BigInt(opts.amount ?? req.amount),
    suggestedParams: params,
    note: new TextEncoder().encode(opts.note ?? `x402-payment-v2-${Math.random()}`),
  });
  algosdk.assignGroupID([feeTxn, xfer]);
  const signed = xfer.signTxn(opts.payer.sk);
  const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
  const payload = {
    x402Version: 2,
    accepted: opts.requirements,
    payload: { paymentGroup: [b64(algosdk.encodeUnsignedTransaction(feeTxn)), b64(signed)], paymentIndex: 1 },
    resource: { url: opts.resourceUrl, description: "", mimeType: "application/json" },
  };
  return { header: encodePaymentSignatureHeader(payload as never), txid: xfer.txID() };
}
