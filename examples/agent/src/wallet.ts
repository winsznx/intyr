import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import algosdk from "algosdk";

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  algod: string;
  indexer: string;
  usdcAssetId: bigint;
  explorer: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    algod: "https://testnet-api.4160.nodely.dev",
    indexer: "https://testnet-idx.4160.nodely.dev",
    usdcAssetId: 10458941n,
    explorer: "https://lora.algokit.io/testnet",
  },
  mainnet: {
    name: "mainnet",
    algod: "https://mainnet-api.4160.nodely.dev",
    indexer: "https://mainnet-idx.4160.nodely.dev",
    usdcAssetId: 31566704n,
    explorer: "https://lora.algokit.io/mainnet",
  },
};

export interface Wallet {
  address: string;
  secretKey: Uint8Array;
  source: string;
}

interface KeyFileEntry {
  address: string;
  mnemonic: string;
}

/**
 * Loads a signer from AVM_MNEMONIC, or from a role in ~/.intyr/keys.json.
 * The key file lives outside the repository and is never printed.
 */
export function loadWallet(role: string): Wallet {
  const fromEnv = process.env.AVM_MNEMONIC;
  if (fromEnv) {
    const account = algosdk.mnemonicToSecretKey(fromEnv.trim());
    return { address: account.addr.toString(), secretKey: account.sk, source: "AVM_MNEMONIC" };
  }
  const file = join(homedir(), ".intyr", "keys.json");
  let keys: Record<string, KeyFileEntry>;
  try {
    keys = JSON.parse(readFileSync(file, "utf8")) as Record<string, KeyFileEntry>;
  } catch {
    throw new Error(`no AVM_MNEMONIC and no readable key file at ${file}`);
  }
  const entry = keys[role];
  if (!entry) throw new Error(`role "${role}" not found in ${file} (have: ${Object.keys(keys).join(", ")})`);
  const account = algosdk.mnemonicToSecretKey(entry.mnemonic);
  if (account.addr.toString() !== entry.address) throw new Error(`key file entry "${role}" does not match its address`);
  return { address: entry.address, secretKey: account.sk, source: `~/.intyr/keys.json#${role}` };
}

/** Base64 of the 64-byte secret key (seed followed by public key), the format toClientAvmSigner expects. */
export function secretKeyBase64(wallet: Wallet): string {
  return Buffer.from(wallet.secretKey).toString("base64");
}

export function algod(network: NetworkConfig): algosdk.Algodv2 {
  return new algosdk.Algodv2("", network.algod, "");
}

export interface Balances {
  address: string;
  microAlgos: bigint;
  minBalance: bigint;
  usdcOptedIn: boolean;
  usdcMicro: bigint;
}

export async function balances(network: NetworkConfig, address: string): Promise<Balances> {
  const info = await algod(network).accountInformation(address).do();
  const holding = (info.assets ?? []).find((a) => BigInt(a.assetId) === network.usdcAssetId);
  return {
    address,
    microAlgos: BigInt(info.amount),
    minBalance: BigInt(info.minBalance),
    usdcOptedIn: holding !== undefined,
    usdcMicro: holding ? BigInt(holding.amount) : 0n,
  };
}

/** Opts the wallet in to the network's USDC asset. Returns the confirmed transaction id. */
export async function optInUsdc(network: NetworkConfig, wallet: Wallet): Promise<{ txid: string; round: bigint }> {
  const client = algod(network);
  const params = await client.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: wallet.address,
    receiver: wallet.address,
    amount: 0,
    assetIndex: network.usdcAssetId,
    suggestedParams: params,
  });
  const signed = txn.signTxn(wallet.secretKey);
  const { txid } = await client.sendRawTransaction(signed).do();
  const result = await algosdk.waitForConfirmation(client, txid, 8);
  return { txid, round: BigInt(result.confirmedRound ?? 0) };
}

/** Sends USDC between two wallets (used to move TestNet funds between test roles). */
export async function sendUsdc(network: NetworkConfig, from: Wallet, to: string, microUsdc: bigint): Promise<{ txid: string; round: bigint }> {
  const client = algod(network);
  const params = await client.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from.address,
    receiver: to,
    amount: microUsdc,
    assetIndex: network.usdcAssetId,
    suggestedParams: params,
  });
  const { txid } = await client.sendRawTransaction(txn.signTxn(from.secretKey)).do();
  const result = await algosdk.waitForConfirmation(client, txid, 8);
  return { txid, round: BigInt(result.confirmedRound ?? 0) };
}
