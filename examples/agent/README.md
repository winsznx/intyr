# Reference agent

A small command-line agent that pays Intyr's endpoints over x402 on Algorand. It uses the standard
`@x402/fetch` and `@x402/avm` client packages, so it shows what any x402 client has to do and nothing more.

```sh
pnpm install
# Signer: AVM_MNEMONIC, or a role in ~/.intyr/keys.json (default testnet_payer)
pnpm --filter @intyr/example-agent agent balance
pnpm --filter @intyr/example-agent agent optin                      # USDC opt-in, needs about 0.2 ALGO
pnpm --filter @intyr/example-agent agent check legs.json --sandbox  # TestNet sandbox route
pnpm --filter @intyr/example-agent agent call GET /v1/prices        # free route, no payment
```

The client refuses any single payment above `--max` (default `$1`) before it signs anything.
TestNet ALGO comes from https://bank.testnet.algorand.network and TestNet USDC from https://faucet.circle.com.
