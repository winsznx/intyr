import algosdk from "algosdk";
import type { Env } from "./env";
import { networkConfig } from "./config";

/**
 * Public addresses of the accounts that sign manifest anchors, keyed by CAIP-2 network. A verifier uses them to reject
 * an anchor note posted by any other account. Only the address is derived from the secret, and only it is published.
 */
export function anchorAccounts(env: Pick<Env, "ANCHOR_MNEMONIC_MAINNET" | "ANCHOR_MNEMONIC_TESTNET">): Record<string, string> {
  const accounts: Record<string, string> = {};
  if (env.ANCHOR_MNEMONIC_MAINNET) accounts[networkConfig("mainnet").caip2] = algosdk.mnemonicToSecretKey(env.ANCHOR_MNEMONIC_MAINNET).addr.toString();
  if (env.ANCHOR_MNEMONIC_TESTNET) accounts[networkConfig("testnet").caip2] = algosdk.mnemonicToSecretKey(env.ANCHOR_MNEMONIC_TESTNET).addr.toString();
  return accounts;
}
