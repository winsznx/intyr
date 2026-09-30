import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { HonoAdapter } from "@x402/hono";
import {
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import type { x402HTTPResourceServer } from "@x402/core/server";
import { canonicalize, hashValue } from "@intyr/core";
import { readBodyWithLimit } from "../body";
import { routePrefix, type NetworkConfig } from "../config";
import type { FeeFailure, RefundSummary } from "./refunds";
import { decodeAvmPayment, PaymentDecodeError, type DecodedPayment } from "./decode";
import { readPaymentTx, type ChainReading } from "./chain";
import {
  completeOperation,
  createOperation,
  getOperationBySession,
  getSessionByTxid,
  insertSession,
  transition,
  WORK_STATES,
  type OperationRow,
  type PayerClass,
  type PaymentSession,
  type PaymentState,
} from "./sessions";

export interface PaidRoute {
  /** `POST /v1/trips/commit` */
  key: string;
  /** Price in atomic USDC units, as a decimal string. */
  amountAtomic: string;
  /** Commit-like routes start supplier work only after our own chain read matches the session. */
  requireChainConfirmation: boolean;
  /**
   * Runs before any charge. A REFUSE or UNKNOWN verdict here costs the caller nothing.
   * Return null to continue to payment.
   */
  precheck?: (body: unknown) => Promise<HandlerResult | null>;
  /** Runs once per settled payment. Must be idempotent on `operationId`. */
  handler: (ctx: PaidContext) => Promise<HandlerResult>;
}

export interface PaidContext {
  network: "mainnet" | "testnet";
  /** True for a sandbox call the server paid for. No USDC moved and `session` is null. */
  sponsored: boolean;
  /** Raw value of the sandbox session cookie, when present. Handlers validate it before using it. */
  sandboxSessionId?: string;
  body: unknown;
  session: PaymentSession | null;
  operationId: string;
  now: string;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
  tripId?: string | null;
  /** Set when the fee bought nothing. The ladder records a refund for the payment. */
  feeFailure?: FeeFailure;
}

export interface LadderDeps {
  db: D1Database;
  /** Runs the refund gate for a payment whose fee bought nothing. Recording failures never change the response. */
  openRefund?: (input: { session: PaymentSession; delivery: FeeFailure; tripId: string | null }) => Promise<RefundSummary>;
  httpServer: x402HTTPResourceServer;
  net: NetworkConfig;
  payTo: string;
  teamWallets: readonly string[];
  fetchFn?: typeof fetch;
  now?: () => string;
  /** Milliseconds to wait for our own chain read to see the payment. */
  confirmWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PAYMENT_HEADERS = ["payment-signature", "x-payment"] as const;

function paymentHeader(c: Context): string | undefined {
  for (const h of PAYMENT_HEADERS) {
    const v = c.req.header(h);
    if (v) return v;
  }
  return undefined;
}

function envelope(session: PaymentSession | null, net: NetworkConfig, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    payment_state: session?.state ?? "CHALLENGED",
    payment_txid: session?.txid ?? null,
    payment_session_id: session?.id ?? null,
    payment_explorer_url: session ? net.explorerTx(session.txid) : null,
  };
}

function pollUrl(origin: string, net: NetworkConfig, session: PaymentSession): string {
  return `${origin}${routePrefix(net.name)}/payments/${session.id}`;
}

/**
 * The x402 payment ladder. Differences from the stock middleware, each on purpose:
 * 1. the payment txid is computed and stored before the facilitator is contacted;
 * 2. for every route that does supplier work, settlement happens before the handler runs
 *    (the `upfront` flow), so free work is never done on a mere verification;
 * 3. an unknown settlement answers 202 with payment_state=UNKNOWN, never 402, and is
 *    resolved by reading the stored txid from a node that is not the facilitator;
 * 4. one payment proof produces at most one operation, and replaying the proof returns it.
 */
export function createLadder(deps: LadderDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function resolveByChain(session: PaymentSession, decoded: { lastValid: number }): Promise<PaymentState | "PENDING"> {
    const reading = await readPaymentTx(deps.net, session.txid, fetchFn);
    return applyReading(session, decoded.lastValid, reading);
  }

  async function applyReading(session: PaymentSession, lastValid: number, reading: ChainReading): Promise<PaymentState | "PENDING"> {
    const at = now();
    if (reading.status === "confirmed") {
      const matches =
        (reading.receiver === "" || reading.receiver === session.pay_to) &&
        (reading.assetId === "" || reading.assetId === session.asset) &&
        (reading.amount === "" || reading.amount === session.amount) &&
        (reading.sender === "" || reading.sender === session.payer);
      if (!matches) {
        await transition(deps.db, session.id, ["UNKNOWN", "SETTLE_FAILED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"], "SETTLE_FAILED", at, {
          last_error: "chain transaction does not match the payment session",
        });
        return "SETTLE_FAILED";
      }
      const from = ["UNKNOWN", "SETTLE_FAILED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"] as const;
      await transition(deps.db, session.id, from, "SETTLED", at, { confirmed_round: reading.round }, { via: "chain_read" });
      await transition(deps.db, session.id, ["SETTLED"], "CONFIRMED", at, { confirmed_round: reading.round }, { via: "chain_read" });
      return "CONFIRMED";
    }
    if (reading.status === "absent" && reading.currentRound > lastValid + 1) {
      await transition(deps.db, session.id, ["UNKNOWN", "SETTLE_FAILED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"], "EXPIRED_UNSETTLED", at, {
        last_error: "payment transaction never confirmed and its validity window has passed",
      });
      return "EXPIRED_UNSETTLED";
    }
    return "PENDING";
  }

  async function confirmOnChain(session: PaymentSession, lastValid: number): Promise<boolean> {
    const deadline = Date.now() + (deps.confirmWaitMs ?? 8000);
    for (;;) {
      const reading = await readPaymentTx(deps.net, session.txid, fetchFn);
      if (reading.status === "confirmed") {
        const state = await applyReading(session, lastValid, reading);
        if (state === "CONFIRMED") return true;
        if (state === "SETTLE_FAILED") return false;
      }
      if (Date.now() >= deadline) return false;
      await sleep(800);
    }
  }

  async function runHandler(
    c: Context,
    route: PaidRoute,
    body: unknown,
    session: PaymentSession,
    settlementHeaders: Record<string, string>,
  ): Promise<Response> {
    const at = now();
    const sandboxSessionId = getCookie(c, "intyr_sbx");
    const { created, operation } = await createOperation(deps.db, session.id, route.key, at);
    if (!created && operation.status !== "PENDING") return replayOperation(c, session, operation, settlementHeaders);
    if (!created && operation.status === "PENDING" && Date.parse(at) - Date.parse(operation.updated_at) < 30_000) {
      return c.json(
        envelope(session, deps.net, { operation_id: operation.id, status: "PROCESSING", poll_url: `${new URL(c.req.url).origin}${routePrefix(deps.net.name)}/operations/${operation.id}` }),
        202,
      );
    }
    let result: HandlerResult;
    try {
      result = await route.handler({ network: deps.net.name, sponsored: false, ...(sandboxSessionId ? { sandboxSessionId } : {}), body, session, operationId: operation.id, now: at });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const refund = await refundFor(session, "INTYR_FAILURE", null);
      const failed = envelope(session, deps.net, {
        operation_id: operation.id,
        outcome: "FAILED_INTERNAL",
        error: "INTERNAL_ERROR",
        message: "The payment settled but the operation failed on our side. The fee is refunded, see refund.",
        refund,
      });
      await completeOperation(deps.db, operation.id, "FAILED", 500, { ...failed, detail: message }, null, now());
      return new Response(JSON.stringify(failed), { status: 500, headers: { "content-type": "application/json", ...settlementHeaders } });
    }
    const refund = result.feeFailure ? await refundFor(session, result.feeFailure, result.tripId ?? null) : undefined;
    const out = envelope(session, deps.net, { operation_id: operation.id, ...result.body, ...(refund ? { refund } : {}) });
    await completeOperation(deps.db, operation.id, "DONE", result.status, out, result.tripId ?? null, now());
    return new Response(JSON.stringify(out), { status: result.status, headers: { "content-type": "application/json", ...settlementHeaders } });
  }

  async function refundFor(session: PaymentSession, delivery: FeeFailure, tripId: string | null): Promise<RefundSummary | { state: "RECORD_FAILED"; note: string }> {
    if (!deps.openRefund) return { state: "RECORD_FAILED", note: "Refunds are not configured on this deployment." };
    try {
      return await deps.openRefund({ session, delivery, tripId });
    } catch (e) {
      console.error("refund record failed", session.id, e instanceof Error ? e.message : String(e));
      return { state: "RECORD_FAILED", note: "The refund could not be recorded. Contact the operator with the payment txid." };
    }
  }

  function replayOperation(c: Context, session: PaymentSession, op: OperationRow, headers: Record<string, string>): Response {
    const stored = op.result_json ? JSON.parse(op.result_json) : {};
    const out = envelope(session, deps.net, { ...stored, operation_id: op.id, replay: true });
    return new Response(JSON.stringify(out), { status: op.http_status ?? 200, headers: { "content-type": "application/json", "intyr-replay": "true", ...headers } });
  }

  return async function handle(c: Context, route: PaidRoute): Promise<Response> {
    const origin = new URL(c.req.url).origin;
    const read = await readBodyWithLimit(c);
    if (!read.ok) return read.response;
    const rawBody = read.raw;
    let body: unknown;
    try {
      body = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "Body must be JSON." }, 400);
    }
    let bodyHash: string;
    try {
      bodyHash = await hashValue(canonicalize(body));
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "Body is not canonicalizable JSON." }, 400);
    }

    // Gate before charge: a foreseeable refusal costs nothing.
    if (route.precheck) {
      const refused = await route.precheck(body);
      if (refused) return c.json(envelope(null, deps.net, { ...refused.body, charged: false }), refused.status as 400);
    }

    const header = paymentHeader(c);
    const adapter = new HonoAdapter(c);
    const context = {
      adapter,
      path: c.req.path,
      decodedPath: c.req.path,
      method: c.req.method,
      paymentHeader: header,
    };

    if (!header) {
      const result = await deps.httpServer.processHTTPRequest(context);
      if (result.type === "payment-error") {
        for (const [k, v] of Object.entries(result.response.headers)) c.header(k, v);
        c.header("x-intyr-body-hash", bodyHash);
        return result.response.isHtml ? c.html(result.response.body as string, result.response.status as 402) : c.json((result.response.body ?? {}) as object, result.response.status as 402);
      }
      return c.json({ error: "INTERNAL_ERROR", message: "route is not payment protected" }, 500);
    }

    // 1. Decode and record the proof before anyone else sees it.
    let decoded: DecodedPayment;
    try {
      const parsed = decodePaymentSignatureHeader(header);
      decoded = decodeAvmPayment((parsed as { payload?: unknown }).payload);
    } catch (e) {
      const message = e instanceof PaymentDecodeError || e instanceof Error ? e.message : "invalid payment header";
      return c.json(envelope(null, deps.net, { error: "PAYMENT_INVALID", message }), 400);
    }
    if (decoded.receiver !== deps.payTo || decoded.assetId !== deps.net.usdcAssetId || decoded.amount !== route.amountAtomic) {
      return c.json(envelope(null, deps.net, { error: "PAYMENT_INVALID", message: "payment does not match the published requirements for this route" }), 402);
    }
    const payerClass: PayerClass = deps.teamWallets.includes(decoded.sender) ? "INTERNAL_VALIDATION" : "EXTERNAL_ANON";
    const inserted = await insertSession(deps.db, {
      txid: decoded.txid,
      route: route.key,
      body_hash: bodyHash,
      network: deps.net.caip2,
      asset: decoded.assetId,
      amount: decoded.amount,
      pay_to: decoded.receiver,
      payer: decoded.sender,
      payer_class: payerClass,
      first_valid: decoded.firstValid,
      last_valid: decoded.lastValid,
      now: now(),
    });
    let session = inserted.session;

    if (!inserted.created) {
      if (session.route !== route.key || session.body_hash !== bodyHash) {
        return c.json(envelope(session, deps.net, { error: "PAYMENT_BINDING_MISMATCH", message: "this payment was made for a different request" }), 409);
      }
      // Same proof again. Never settle twice and never start a second operation.
      if (WORK_STATES.includes(session.state)) {
        return runHandlerWithKnownSettlement(c, route, body, session);
      }
      if (session.state === "UNKNOWN" || session.state === "SETTLE_SUBMITTED" || session.state === "SETTLE_FAILED" || session.state === "PROOF_RECEIVED") {
        const resolved = await resolveByChain(session, decoded);
        session = (await getSessionByTxid(deps.db, decoded.txid))!;
        if (resolved === "CONFIRMED") return runHandlerWithKnownSettlement(c, route, body, session);
        if (resolved === "EXPIRED_UNSETTLED" || resolved === "SETTLE_FAILED") {
          return c.json(envelope(session, deps.net, { error: "PAYMENT_NOT_SETTLED", message: "The payment never reached the ledger. No work was done and nothing was charged.", charged: false }), 402);
        }
        return c.json(envelope(session, deps.net, { status: "PAYMENT_PENDING", poll_url: pollUrl(origin, deps.net, session), message: "Settlement status is unknown. Do not pay again; poll this URL." }), 202);
      }
      return c.json(envelope(session, deps.net, { error: "PAYMENT_NOT_USABLE", message: `payment session is ${session.state}` }), 402);
    }

    // 2. Verify, then settle, and only then do any work. The txid is already stored.
    let verified: Awaited<ReturnType<typeof deps.httpServer.processHTTPRequest>>;
    try {
      verified = await deps.httpServer.processHTTPRequest(context);
    } catch (e) {
      return unknownSettlement(c, session, decoded, e, route, body, origin);
    }
    if (verified.type === "payment-error") {
      // The facilitator may already hold this payment (for example a settle that succeeded earlier). Ask the chain first.
      const resolved = await resolveByChain(session, decoded);
      session = (await getSessionByTxid(deps.db, decoded.txid))!;
      if (resolved === "CONFIRMED") return runHandlerWithKnownSettlement(c, route, body, session);
      await transition(deps.db, session.id, ["PROOF_RECEIVED"], "VERIFY_FAILED", now(), { last_error: JSON.stringify(verified.response.body ?? {}).slice(0, 500) });
      session = (await getSessionByTxid(deps.db, decoded.txid))!;
      for (const [k, v] of Object.entries(verified.response.headers)) c.header(k, v);
      return c.json(envelope(session, deps.net, { error: "PAYMENT_INVALID", payment_required: verified.response.body ?? {}, charged: false }), 402);
    }
    if (verified.type !== "payment-verified") {
      return c.json(envelope(session, deps.net, { error: "INTERNAL_ERROR", message: "route is not payment protected" }), 500);
    }
    await transition(deps.db, session.id, ["PROOF_RECEIVED"], "VERIFIED", now(), {}, {});
    await transition(deps.db, session.id, ["VERIFIED"], "SETTLE_SUBMITTED", now(), {}, { txid: decoded.txid });
    session = (await getSessionByTxid(deps.db, decoded.txid))!;

    let settled: Awaited<ReturnType<typeof deps.httpServer.processSettlement>>;
    try {
      settled = await deps.httpServer.processSettlement(
        verified.paymentPayload,
        verified.paymentRequirements,
        verified.declaredExtensions,
        { request: context },
      );
    } catch (e) {
      return unknownSettlement(c, session, decoded, e, route, body, origin);
    }
    if (!settled.success) {
      // Verification already passed, so a failed settle is most likely transient and the transaction may still land.
      // Treat it as unknown, never as a definitive failure, and resolve it from the ledger.
      return unknownSettlement(c, session, decoded, new Error(`${settled.errorReason}${settled.errorMessage ? `: ${settled.errorMessage}` : ""}`), route, body, origin);
    }
    await transition(deps.db, session.id, ["SETTLE_SUBMITTED"], "SETTLED", now(), { settle_json: JSON.stringify({ transaction: settled.transaction, network: settled.network, payer: settled.payer }) }, { facilitator_tx: settled.transaction });
    session = (await getSessionByTxid(deps.db, decoded.txid))!;

    return runHandlerWithKnownSettlement(c, route, body, session, settled.headers, decoded.lastValid);
  };

  async function unknownSettlement(
    c: Context,
    session: PaymentSession,
    decoded: DecodedPayment,
    error: unknown,
    route: PaidRoute,
    body: unknown,
    origin: string,
  ): Promise<Response> {
    const message = error instanceof Error ? error.message : String(error);
    await transition(deps.db, session.id, ["VERIFIED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"], "UNKNOWN", now(), { last_error: message.slice(0, 500) });
    const resolved = await resolveByChain((await getSessionByTxid(deps.db, decoded.txid))!, decoded);
    const latest = (await getSessionByTxid(deps.db, decoded.txid))!;
    if (resolved === "CONFIRMED") return runHandlerWithKnownSettlement(c, route, body, latest);
    if (resolved === "EXPIRED_UNSETTLED" || resolved === "SETTLE_FAILED") {
      return c.json(envelope(latest, deps.net, { error: "PAYMENT_NOT_SETTLED", message: "The payment never reached the ledger. Nothing was charged.", charged: false }), 402);
    }
    // Never a 402 here: the caller may already have paid, and a 402 invites a second payment.
    return c.json(envelope(latest, deps.net, { status: "PAYMENT_PENDING", poll_url: pollUrl(origin, deps.net, latest), message: "Settlement status is unknown. Do not pay again; poll this URL." }), 202);
  }

  async function runHandlerWithKnownSettlement(
    c: Context,
    route: PaidRoute,
    body: unknown,
    session: PaymentSession,
    settlementHeaders: Record<string, string> = {},
    lastValid?: number,
  ): Promise<Response> {
    if (route.requireChainConfirmation && session.state === "SETTLED") {
      const ok = await confirmOnChain(session, lastValid ?? session.last_valid);
      session = (await getSessionByTxid(deps.db, session.txid))!;
      if (!ok) {
        return c.json(
          envelope(session, deps.net, {
            status: "PAYMENT_CONFIRMATION_PENDING",
            poll_url: pollUrl(new URL(c.req.url).origin, deps.net, session),
            message: "The payment settled but our own ledger read has not confirmed it yet. Replay the same request with the same proof.",
          }),
          202,
        );
      }
    }
    return runHandler(c, route, body, session, settlementHeaders);
  }
}

export type Ladder = ReturnType<typeof createLadder>;

/** Used by the scheduled reconciler. */
export async function reconcileSession(
  deps: Pick<LadderDeps, "db" | "net" | "fetchFn" | "now">,
  session: PaymentSession,
): Promise<PaymentState | "PENDING"> {
  const now = deps.now ?? (() => new Date().toISOString());
  const reading = await readPaymentTx(deps.net, session.txid, deps.fetchFn ?? fetch);
  const at = now();
  if (reading.status === "confirmed") {
    const from = ["UNKNOWN", "SETTLE_FAILED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"] as const;
    await transition(deps.db, session.id, from, "SETTLED", at, { confirmed_round: reading.round }, { via: "reconciler" });
    await transition(deps.db, session.id, ["SETTLED"], "CONFIRMED", at, { confirmed_round: reading.round }, { via: "reconciler" });
    return "CONFIRMED";
  }
  if (reading.status === "absent" && reading.currentRound > session.last_valid + 1) {
    await transition(deps.db, session.id, ["UNKNOWN", "SETTLE_FAILED", "SETTLE_SUBMITTED", "PROOF_RECEIVED"], "EXPIRED_UNSETTLED", at, {
      last_error: "validity window passed without confirmation",
    });
    return "EXPIRED_UNSETTLED";
  }
  return "PENDING";
}
