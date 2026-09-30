import { newId } from "@intyr/core";

export const PAYMENT_STATES = [
  "CHALLENGED",
  "PROOF_RECEIVED",
  "VERIFIED",
  "SETTLE_SUBMITTED",
  "SETTLED",
  "CONFIRMED",
  "RECONCILED",
  "VERIFY_FAILED",
  "SETTLE_FAILED",
  "EXPIRED_UNSETTLED",
  "UNKNOWN",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PayerClass = "EXTERNAL_ANON" | "EXTERNAL_ORG" | "INTERNAL_VALIDATION" | "SANDBOX";

/** Allowed edges. Anything else is a bug and fails closed. */
export const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CHALLENGED: ["PROOF_RECEIVED"],
  PROOF_RECEIVED: ["VERIFIED", "SETTLE_SUBMITTED", "SETTLED", "VERIFY_FAILED", "SETTLE_FAILED", "UNKNOWN", "EXPIRED_UNSETTLED"],
  VERIFIED: ["SETTLE_SUBMITTED", "VERIFY_FAILED", "UNKNOWN", "EXPIRED_UNSETTLED"],
  SETTLE_SUBMITTED: ["SETTLED", "SETTLE_FAILED", "UNKNOWN", "EXPIRED_UNSETTLED"],
  SETTLED: ["CONFIRMED", "RECONCILED", "UNKNOWN"],
  CONFIRMED: ["RECONCILED"],
  RECONCILED: [],
  VERIFY_FAILED: [],
  SETTLE_FAILED: ["SETTLE_SUBMITTED", "SETTLED", "EXPIRED_UNSETTLED", "UNKNOWN"],
  EXPIRED_UNSETTLED: [],
  UNKNOWN: ["SETTLED", "CONFIRMED", "EXPIRED_UNSETTLED", "SETTLE_FAILED"],
};

/** States from which paid work may start (D2 section D). */
export const WORK_STATES: readonly PaymentState[] = ["SETTLED", "CONFIRMED", "RECONCILED"];

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export interface PaymentSession {
  id: string;
  txid: string;
  route: string;
  body_hash: string;
  network: string;
  asset: string;
  amount: string;
  pay_to: string;
  payer: string;
  payer_class: PayerClass;
  state: PaymentState;
  first_valid: number;
  last_valid: number;
  settle_json: string | null;
  confirmed_round: number | null;
  operation_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperationRow {
  id: string;
  session_id: string;
  route: string;
  status: "PENDING" | "DONE" | "FAILED";
  http_status: number | null;
  result_json: string | null;
  trip_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSession {
  txid: string;
  route: string;
  body_hash: string;
  network: string;
  asset: string;
  amount: string;
  pay_to: string;
  payer: string;
  payer_class: PayerClass;
  first_valid: number;
  last_valid: number;
  now: string;
}

export async function insertSession(db: D1Database, s: NewSession): Promise<{ created: boolean; session: PaymentSession }> {
  const id = newId("pay");
  const res = await db
    .prepare(
      `INSERT INTO payment_sessions (id, txid, route, body_hash, network, asset, amount, pay_to, payer, payer_class, state, first_valid, last_valid, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'PROOF_RECEIVED',?11,?12,?13,?13)
       ON CONFLICT(txid) DO NOTHING`,
    )
    .bind(id, s.txid, s.route, s.body_hash, s.network, s.asset, s.amount, s.pay_to, s.payer, s.payer_class, s.first_valid, s.last_valid, s.now)
    .run();
  const created = (res.meta?.changes ?? 0) > 0;
  const session = (await getSessionByTxid(db, s.txid))!;
  if (created) await recordEvent(db, session.id, null, "PROOF_RECEIVED", {}, s.now);
  return { created, session };
}

export function getSessionByTxid(db: D1Database, txid: string): Promise<PaymentSession | null> {
  return db.prepare("SELECT * FROM payment_sessions WHERE txid = ?1").bind(txid).first<PaymentSession>();
}

export function getSessionById(db: D1Database, id: string): Promise<PaymentSession | null> {
  return db.prepare("SELECT * FROM payment_sessions WHERE id = ?1").bind(id).first<PaymentSession>();
}

export async function recordEvent(
  db: D1Database,
  sessionId: string,
  from: PaymentState | null,
  to: PaymentState,
  detail: Record<string, unknown>,
  now: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO payment_events (session_id, from_state, to_state, detail_json, at) VALUES (?1,?2,?3,?4,?5)")
    .bind(sessionId, from, to, JSON.stringify(detail), now)
    .run();
}

export interface TransitionPatch {
  settle_json?: string | null;
  confirmed_round?: number | null;
  operation_id?: string | null;
  last_error?: string | null;
}

/** Compare-and-set transition. Returns false when the session was not in one of the `from` states. */
export async function transition(
  db: D1Database,
  sessionId: string,
  from: readonly PaymentState[],
  to: PaymentState,
  now: string,
  patch: TransitionPatch = {},
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const legal = from.filter((f) => canTransition(f, to));
  if (legal.length === 0) throw new Error(`illegal payment transition ${from.join("|")} -> ${to}`);
  const placeholders = legal.map((_, i) => `?${i + 6}`).join(",");
  const res = await db
    .prepare(
      `UPDATE payment_sessions SET state = ?1, updated_at = ?2,
         settle_json = COALESCE(?3, settle_json),
         confirmed_round = COALESCE(?4, confirmed_round),
         last_error = COALESCE(?5, last_error)
       WHERE id = ?${legal.length + 6} AND state IN (${placeholders})`,
    )
    .bind(to, now, patch.settle_json ?? null, patch.confirmed_round ?? null, patch.last_error ?? null, ...legal, sessionId)
    .run();
  const ok = (res.meta?.changes ?? 0) > 0;
  if (ok) await recordEvent(db, sessionId, null, to, { from, ...detail }, now);
  return ok;
}

export function getOperationBySession(db: D1Database, sessionId: string): Promise<OperationRow | null> {
  return db.prepare("SELECT * FROM operations WHERE session_id = ?1").bind(sessionId).first<OperationRow>();
}

export function getOperation(db: D1Database, id: string): Promise<OperationRow | null> {
  return db.prepare("SELECT * FROM operations WHERE id = ?1").bind(id).first<OperationRow>();
}

export async function createOperation(
  db: D1Database,
  sessionId: string,
  route: string,
  now: string,
): Promise<{ created: boolean; operation: OperationRow }> {
  const id = newId("ops");
  const res = await db
    .prepare(
      `INSERT INTO operations (id, session_id, route, status, created_at, updated_at)
       VALUES (?1,?2,?3,'PENDING',?4,?4) ON CONFLICT(session_id) DO NOTHING`,
    )
    .bind(id, sessionId, route, now)
    .run();
  const operation = (await getOperationBySession(db, sessionId))!;
  if ((res.meta?.changes ?? 0) > 0) {
    await db.prepare("UPDATE payment_sessions SET operation_id = ?1 WHERE id = ?2").bind(operation.id, sessionId).run();
  }
  return { created: (res.meta?.changes ?? 0) > 0, operation };
}

export async function completeOperation(
  db: D1Database,
  operationId: string,
  status: "DONE" | "FAILED",
  httpStatus: number,
  result: unknown,
  tripId: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare("UPDATE operations SET status = ?1, http_status = ?2, result_json = ?3, trip_id = ?4, updated_at = ?5 WHERE id = ?6")
    .bind(status, httpStatus, JSON.stringify(result), tripId, now, operationId)
    .run();
}

export async function listStaleSessions(db: D1Database, states: readonly PaymentState[], olderThanIso: string): Promise<PaymentSession[]> {
  const placeholders = states.map((_, i) => `?${i + 2}`).join(",");
  const res = await db
    .prepare(`SELECT * FROM payment_sessions WHERE updated_at < ?1 AND state IN (${placeholders}) ORDER BY updated_at LIMIT 50`)
    .bind(olderThanIso, ...states)
    .all<PaymentSession>();
  return res.results ?? [];
}
