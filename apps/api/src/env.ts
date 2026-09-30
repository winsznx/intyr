export type NetworkName = "mainnet" | "testnet";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  FACILITATOR_URL: string;
  /** Receive-only Mainnet address that x402 payments settle to. Public value. Unset disables /v1. */
  PAY_TO_MAINNET?: string;
  /** Receive-only TestNet address for the sandbox. Unset disables /sandbox/v1. */
  PAY_TO_TESTNET?: string;
  /** Comma separated wallets controlled by the team. Payments from them are tagged INTERNAL_VALIDATION. */
  TEAM_WALLETS?: string;
  ALGOD_URL?: string;
  INDEXER_URL?: string;
  /** JWK of the Ed25519 manifest signing key (secret). */
  MANIFEST_SIGNING_JWK?: string;
  /** Mnemonics of the small hot anchor accounts, one per network (secrets). */
  ANCHOR_MNEMONIC_MAINNET?: string;
  ANCHOR_MNEMONIC_TESTNET?: string;
  DUFFEL_TOKEN?: string;
  LITEAPI_KEY?: string;
}
