import { ALGORAND_MAINNET_CAIP2, ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_CAIP2, ALGORAND_TESTNET_GENESIS_HASH, ExactAvmScheme, toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";

import { secretKeyBase64, type NetworkName, type Wallet } from "./wallet";

export interface PaidResponse {
  status: number;
  body: unknown;
  paymentResponse: unknown;
  headers: Record<string, string>;
}

/**
 * Builds a fetch that answers x402 challenges from this wallet. The per-payment
 * cap is enforced by the x402 client before anything is signed.
 */
export function payingFetch(wallet: Wallet, network: NetworkName, maxUsdPerPayment: string): { fetch: typeof fetch; http: x402HTTPClient } {
  const signer = toClientAvmSigner(secretKeyBase64(wallet));
  const scheme = new ExactAvmScheme(signer);
  // Servers advertise either the 32-character CAIP-2 reference or the full genesis hash; accept both.
  const networks = network === "mainnet"
    ? [ALGORAND_MAINNET_CAIP2, `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`]
    : [ALGORAND_TESTNET_CAIP2, `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`];
  const client = x402Client.fromConfig({
    schemes: networks.map((n) => ({ network: n as `${string}:${string}`, client: scheme })),
    spendControls: { maxAmountPerPayment: maxUsdPerPayment },
  });
  return { fetch: wrapFetchWithPayment(fetch, client), http: new x402HTTPClient(client) };
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function paidCall(
  wallet: Wallet,
  network: NetworkName,
  url: string,
  init: { method: string; body?: unknown },
  maxUsdPerPayment: string,
): Promise<PaidResponse> {
  const { fetch: pay, http } = payingFetch(wallet, network, maxUsdPerPayment);
  const res = await pay(url, {
    method: init.method,
    headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  let paymentResponse: unknown = null;
  try {
    paymentResponse = http.getPaymentSettleResponse((name) => res.headers.get(name));
  } catch {
    paymentResponse = null;
  }
  return { status: res.status, body, paymentResponse, headers: headerRecord(res.headers) };
}
