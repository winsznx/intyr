import algosdk from "algosdk";
import { PUBLIC_DEFAULT_POLICY, decideRefund, newId, type Environment, type GateDecision } from "@intyr/core";
import { RejectedError, getSuggestedParams, submitSigned } from "../algod";
import type { NetworkConfig } from "../config";
import { readPaymentTx } from "./chain";
import { WORK_STATES, getSessionById, type PaymentSession } from "./sessions";

/** A paid call whose fee bought nothing. Delivered work keeps its fee and never reaches this module. */
export type FeeFailure = "INTYR_FAILURE" | "COMMIT_NOT_EXECUTED";

export type RefundState = "REQUESTED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN" | "DEFERRED";

export interface RefundRow {
  id: string;
  payment_session_id: string;
  state: RefundState;
  amount: string;
  reason: string;
  txid: string | null;
  network: string | null;
  trip_id: string | null;
  delivery: FeeFailure | null;
  decision_json: string | null;
  last_valid: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundSummary {
  id: string;
  state: RefundState;
  amount: string;
  reason: string;
  txid: string | null;
}

export function summarize(row: RefundRow): RefundSummary {
  return { id: row.id, state: row.state, amount: row.amount, reason: row.reason, txid: row.txid };
}

export function getRefundBySession(db: D1Database, sessionId: string): Promise<RefundRow | null> {
  return db.prepare("SELECT * FROM refunds WHERE payment_session_id = ?1").bind(sessionId).first<RefundRow>();
}

export interface OpenRefundInput {
  session: PaymentSession;
  environment: Environment;
  delivery: FeeFailure;
  tripId: string | null;
  now: Date;
}

/**
 * Runs the REFUND gate for a fee that bought nothing and records the outcome. TestNet refunds are REQUESTED and
 * executed by the cron. Mainnet refunds are DEFERRED for an operator, never sent automatically.
 * One refund per payment: a second call returns the first.
 */
export async function openFeeRefund(db: D1Database, input: OpenRefundInput): Promise<RefundRow> {
  const existing = await getRefundBySession(db, input.session.id);
  if (existing) return existing;
  const decision: GateDecision = await decideRefund({
    session_id: input.session.id,
    environment: input.environment,
    delivery: input.delivery,
    amount_minor: Number(input.session.amount),
    policy_version: PUBLIC_DEFAULT_POLICY.policy_version,
    now: input.now,
  });
  const state: RefundState = decision.outcome === "ACT" ? "REQUESTED" : "DEFERRED";
  const at = input.now.toISOString();
  await db
    .prepare(
      `INSERT INTO refunds (id, payment_session_id, state, amount, reason, txid, network, trip_id, delivery, decision_json, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10,?10) ON CONFLICT(payment_session_id) DO NOTHING`,
    )
    .bind(newId("rfd"), input.session.id, state, input.session.amount, decision.reason_codes[0] ?? input.delivery, input.session.network, input.tripId, input.delivery, JSON.stringify(decision), at)
    .run();
  return (await getRefundBySession(db, input.session.id))!;
}

export interface RefundSigner {
  net: NetworkConfig;
  /** Mnemonic of the payTo account that received the fee. Only ever configured for TestNet. */
  mnemonic: string;
  fetchFn?: typeof fetch;
}

async function moveTo(db: D1Database, id: string, from: RefundState[], patch: { state: RefundState; txid?: string; last_valid?: number; error?: string | null }, now: string): Promise<boolean> {
  const marks = from.map((_, i) => `?${i + 6}`).join(",");
  const res = await db
    .prepare(`UPDATE refunds SET state = ?1, txid = COALESCE(?2, txid), last_valid = COALESCE(?3, last_valid), error = ?4, updated_at = ?5 WHERE id = ?${from.length + 6} AND state IN (${marks})`)
    .bind(patch.state, patch.txid ?? null, patch.last_valid ?? null, patch.error ?? null, now, ...from, id)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

async function rowsIn(db: D1Database, states: RefundState[], network: string): Promise<RefundRow[]> {
  const marks = states.map((_, i) => `?${i + 2}`).join(",");
  const r = await db.prepare(`SELECT * FROM refunds WHERE network = ?1 AND state IN (${marks}) ORDER BY updated_at LIMIT 10`).bind(network, ...states).all<RefundRow>();
  return r.results ?? [];
}

/**
 * Resolves refunds that were submitted. A refund is CONFIRMED only when an independent node shows the transfer
 * to the original payer for the original amount. It is FAILED only after its last valid round has passed
 * without the transaction appearing, at which point it can never confirm.
 */
export async function settleSubmittedRefunds(db: D1Database, signer: RefundSigner, now: Date): Promise<number> {
  const fetchFn = signer.fetchFn ?? fetch;
  let settled = 0;
  for (const row of await rowsIn(db, ["SUBMITTED", "UNKNOWN"], signer.net.caip2)) {
    if (!row.txid) continue;
    const session = await getSessionById(db, row.payment_session_id);
    if (!session) continue;
    const reading = await readPaymentTx(signer.net, row.txid, fetchFn);
    if (reading.status === "confirmed") {
      const exact = reading.sender === session.pay_to && reading.receiver === session.payer && reading.assetId === signer.net.usdcAssetId && reading.amount === row.amount;
      const moved = await moveTo(db, row.id, ["SUBMITTED", "UNKNOWN"], exact ? { state: "CONFIRMED" } : { state: "UNKNOWN", error: "confirmed transfer does not match the refund" }, now.toISOString());
      if (moved && exact) settled++;
    } else if (reading.status === "absent" && row.last_valid !== null && reading.currentRound > row.last_valid) {
      if (await moveTo(db, row.id, ["SUBMITTED", "UNKNOWN"], { state: "FAILED", error: "not seen on chain before its last valid round" }, now.toISOString())) settled++;
    }
  }
  return settled;
}

/**
 * Sends REQUESTED refunds. The transaction id is written before the transaction is submitted, and only one runner
 * can claim a refund, so a crash or a second cron run can never send the same refund twice.
 */
export async function executeRefunds(db: D1Database, signer: RefundSigner, now: Date): Promise<number> {
  if (signer.net.name !== "testnet") return 0;
  const fetchFn = signer.fetchFn ?? fetch;
  const account = algosdk.mnemonicToSecretKey(signer.mnemonic);
  let sent = 0;
  for (const row of await rowsIn(db, ["REQUESTED"], signer.net.caip2)) {
    const session = await getSessionById(db, row.payment_session_id);
    const at = now.toISOString();
    if (!session || !WORK_STATES.includes(session.state)) {
      await moveTo(db, row.id, ["REQUESTED"], { state: "REQUESTED", error: "the payment is not confirmed settled" }, at);
      continue;
    }
    if (session.pay_to !== account.addr.toString()) {
      await moveTo(db, row.id, ["REQUESTED"], { state: "REQUESTED", error: "the refund signer is not the payTo of this payment" }, at);
      continue;
    }
    const suggested = await getSuggestedParams(signer.net, fetchFn);
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: session.payer,
      amount: BigInt(row.amount),
      assetIndex: Number(signer.net.usdcAssetId),
      note: new TextEncoder().encode(`intyr:refund:v1:${row.id}`),
      suggestedParams: suggested,
    });
    const txid = txn.txID();
    if (!(await moveTo(db, row.id, ["REQUESTED"], { state: "SUBMITTED", txid, last_valid: Number(suggested.lastValid) }, at))) continue;
    try {
      await submitSigned(signer.net, txn.signTxn(account.sk), fetchFn);
      sent++;
    } catch (e) {
      if (e instanceof RejectedError) await moveTo(db, row.id, ["SUBMITTED"], { state: "FAILED", error: e.message }, at);
    }
  }
  return sent;
}

/** One cron pass for a network: settle what was sent, then send what was requested. */
export async function reconcileRefunds(db: D1Database, signer: RefundSigner, now: Date): Promise<number> {
  return (await settleSubmittedRefunds(db, signer, now)) + (await executeRefunds(db, signer, now));
}
