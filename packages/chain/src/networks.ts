export type NetworkName = "mainnet" | "testnet";

/** The two endpoints every read and write needs. The API's NetworkConfig satisfies it structurally. */
export interface ChainEndpoints {
  algodUrl: string;
  indexerUrl: string;
  /** Second public domain of the same operator, tried once when the primary is unavailable. */
  fallback?: { algodUrl: string; indexerUrl: string };
}

export interface AlgorandNetwork extends ChainEndpoints {
  name: NetworkName;
  /** CAIP-2 id used by x402 payment requirements. */
  caip2: string;
  genesisId: string;
  genesisHash: string;
  usdcAssetId: number;
  explorerTxBase: string;
}

/** Public Nodely endpoints need no token, so a verifier can run without any Intyr credentials. */
export const NETWORKS: Readonly<Record<NetworkName, AlgorandNetwork>> = {
  mainnet: {
    name: "mainnet",
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    genesisId: "mainnet-v1.0",
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    usdcAssetId: 31566704,
    algodUrl: "https://mainnet-api.4160.nodely.dev",
    indexerUrl: "https://mainnet-idx.4160.nodely.dev",
    fallback: { algodUrl: "https://mainnet-api.algonode.cloud", indexerUrl: "https://mainnet-idx.algonode.cloud" },
    explorerTxBase: "https://allo.info/tx/",
  },
  testnet: {
    name: "testnet",
    caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    genesisId: "testnet-v1.0",
    genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    usdcAssetId: 10458941,
    algodUrl: "https://testnet-api.4160.nodely.dev",
    indexerUrl: "https://testnet-idx.4160.nodely.dev",
    fallback: { algodUrl: "https://testnet-api.algonode.cloud", indexerUrl: "https://testnet-idx.algonode.cloud" },
    explorerTxBase: "https://testnet.allo.info/tx/",
  },
};

export function networkByCaip2(caip2: string): AlgorandNetwork | undefined {
  return Object.values(NETWORKS).find((n) => n.caip2 === caip2);
}

export function explorerTxUrl(network: AlgorandNetwork, txid: string): string {
  return network.explorerTxBase + encodeURIComponent(txid);
}
