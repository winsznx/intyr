export type NetworkName = "mainnet" | "testnet";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Which chain this deployment charges on. */
  NETWORK: NetworkName;
  FACILITATOR_URL: string;
  /** Receive-only address that x402 payments settle to. Public value. */
  PAY_TO: string;
  /** Comma separated wallets controlled by the team. Payments from them are tagged INTERNAL_VALIDATION. */
  TEAM_WALLETS?: string;
  ALGOD_URL?: string;
  INDEXER_URL?: string;
  /** JWK of the Ed25519 manifest signing key (secret). */
  MANIFEST_SIGNING_JWK?: string;
  /** Mnemonic of the anchor signer (secret). */
  ANCHOR_MNEMONIC?: string;
  DUFFEL_TOKEN?: string;
  LITEAPI_KEY?: string;
}
