import { canonicalize, hashValue } from "@intyr/core";

import type { ComponentClocks, FetchLike, Money, SupplierRefs } from "./contract";

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "XOF", "XAF"]);

/** USDC amounts keep all six decimals, so sub-cent x402 prices stay exact. */
function exponent(currency: string): number {
  const code = currency.toUpperCase();
  if (code === "USDC") return 6;
  return ZERO_DECIMAL.has(code) ? 0 : 2;
}

/** Converts a supplier decimal amount ("123.45" or 123.45) to integer minor units. */
export function toMoney(amount: string | number, currency: string): Money {
  const value = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) throw new TypeError(`toMoney: invalid amount ${String(amount)}`);
  return { amount_minor: Math.round(value * 10 ** exponent(currency)), currency: currency.toUpperCase() };
}

/** Formats minor units back to the decimal string suppliers expect. */
export function toDecimal(money: Money): string {
  const exp = exponent(money.currency);
  return (money.amount_minor / 10 ** exp).toFixed(exp);
}

/** Hashes any JSON value (undefined fields dropped) as `sha256:<hex>` over its RFC 8785 form. */
export async function hashJson(value: unknown): Promise<string> {
  const plain: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
  return hashValue(canonicalize(plain));
}

export function emptyRefs(overrides: Partial<SupplierRefs> = {}): SupplierRefs {
  return {
    offer_id: null,
    hold_order_id: null,
    prebook_id: null,
    booking_id: null,
    booking_reference: null,
    passenger_ids: [],
    ...overrides,
  };
}

export function unknownClocks(overrides: Partial<ComponentClocks> = {}): ComponentClocks {
  return {
    price_valid_until: null,
    inventory_held_until: null,
    free_cancel_until: null,
    void_until: null,
    refund_destination: "UNKNOWN",
    refund_amount_certainty: "UNKNOWN",
    confirmation_mode: "INSTANT",
    supplier_can_cancel: true,
    ...overrides,
  };
}

/** Supplier text is untrusted input: strip markup and control characters and cap the length. */
export function untrusted(text: unknown, max = 280): string | null {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, max);
}

export class SupplierTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`supplier call timed out after ${timeoutMs} ms: ${url}`);
    this.name = "SupplierTimeoutError";
  }
}

export interface JsonResponse {
  status: number;
  body: unknown;
  text: string;
}

/**
 * fetch with a hard timeout. A timeout or network error is surfaced as an
 * exception so the caller can map it to UNKNOWN, never to failure.
 */
export async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, text };
  } catch (err) {
    if (controller.signal.aborted) throw new SupplierTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function iso(date: Date): string {
  return date.toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
