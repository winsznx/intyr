import type { Env, NetworkName } from "./env";

export interface NetworkConfig {
  name: NetworkName;
  caip2: string;
  usdcAssetId: string;
  algodUrl: string;
  indexerUrl: string;
  explorerTx: (txid: string) => string;
}

const MAINNET: NetworkConfig = {
  name: "mainnet",
  caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  usdcAssetId: "31566704",
  algodUrl: "https://mainnet-api.4160.nodely.dev",
  indexerUrl: "https://mainnet-idx.4160.nodely.dev",
  explorerTx: (txid) => `https://allo.info/tx/${txid}`,
};

const TESTNET: NetworkConfig = {
  name: "testnet",
  caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  usdcAssetId: "10458941",
  algodUrl: "https://testnet-api.4160.nodely.dev",
  indexerUrl: "https://testnet-idx.4160.nodely.dev",
  explorerTx: (txid) => `https://testnet.allo.info/tx/${txid}`,
};

export function networkConfig(env: Pick<Env, "NETWORK" | "ALGOD_URL" | "INDEXER_URL">): NetworkConfig {
  const base = env.NETWORK === "mainnet" ? MAINNET : TESTNET;
  return { ...base, algodUrl: env.ALGOD_URL ?? base.algodUrl, indexerUrl: env.INDEXER_URL ?? base.indexerUrl };
}

export const CHALLENGE_TAG = "x402-global-challenge";
