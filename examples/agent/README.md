# Reference agent

A small command-line agent that pays Intyr's endpoints over x402 on Algorand. It uses the standard
`@x402/fetch` and `@x402/avm` client packages, so it shows what any x402 client has to do and nothing more.

```sh
pnpm install
# Signer: AVM_MNEMONIC, or a role in ~/.intyr/keys.json (default testnet_payer)
pnpm --filter @intyr/example-agent agent balance
pnpm --filter @intyr/example-agent agent optin                                        # USDC opt-in, needs about 0.2 ALGO
pnpm --filter @intyr/example-agent agent check requests/check.json --sandbox          # paid on TestNet
pnpm --filter @intyr/example-agent agent prepare requests/prepare.json --sandbox
pnpm --filter @intyr/example-agent agent call GET /v1/prices                          # free route, no payment
```

The client refuses any single payment above `--max` (default `$1`) before it signs anything.
TestNet ALGO comes from https://bank.testnet.algorand.network and TestNet USDC from https://faucet.circle.com.

## Example requests

| File | Route | What comes back |
|---|---|---|
| `requests/check.json` | `POST /trips/check` | A signed commit plan: order `hotel, flight, transfer` (the transfer depends on the flight), per-leg readiness, verdict `COMMIT_NOW` |
| `requests/check-irreversible.json` | `POST /trips/check` | The same trip with a non-refundable, pay-now flight: verdict `DO_NOT_COMMIT`, outcome `REFUSE`, reason `READINESS_BELOW_THRESHOLD` |
| `requests/prepare.json` | `POST /trips/prepare` | A trip with a signed Commit Manifest; each leg states its supplier class and evidence grade |
| `requests/prepare-with-fault.json` | `POST /sandbox/v1/trips/prepare` | A seeded simulator trip where the flight is booked but the response is lost. Commit returns `202` with the flight `COMMIT_STATUS_UNKNOWN` and does not rebook it. Resolving that state is the scheduled reconciler's job; on 2026-09-30 the live deploy did not yet advance it (tracked as a known issue) |

All four results above were produced by the live sandbox on 2026-09-30. Scenarios (`scenario`) are accepted on
the sandbox host only.

## Without a wallet

The sandbox also accepts calls under a browser-style session that the server sponsors on TestNet (no USDC moves,
60 calls per hour per session):

```sh
curl -s -c jar -X POST https://intyr.timjosh507.workers.dev/sandbox/session
curl -s -b jar -X POST https://intyr.timjosh507.workers.dev/sandbox/v1/trips/check \
  -H 'content-type: application/json' -d @requests/check.json
```
