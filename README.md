# Intyr

Intyr is a commit and recovery API for AI agents that buy multi-supplier trips. An agent pays for each step
in USDC over [x402](https://x402.org) on Algorand, with no account. Intyr commits the legs in a safe order.
When a supplier fails partway through, Intyr unwinds what can still be undone and reports exactly what
cannot. Every step ends in a signed record that anyone can check against the chain.

Live: https://intyr.timjosh507.workers.dev. Built for the Algorand Global x402 Challenge.

## The problem

An agent that books a flight, a hotel and a transfer makes three separate calls to three suppliers. If the
flight fails after the hotel confirmed, the agent is left with half a trip. Worse, a timeout doesn't say
whether the booking happened. Retrying can book it twice, and giving up can leave it booked and unpaid for.
Intyr treats "I don't know" as a state of its own, and reconciles it by reading the supplier before it does
anything else.

## Paid steps

| Route | Price | Returns |
|---|---|---|
| `POST /v1/trips/check` | 0.10 USDC | A signed commit plan for legs the agent already has: commit order (reversible first, irreversible last), hold strength per leg, what cannot be undone, and a verdict |
| `POST /v1/trips/prepare` | 0.25 USDC | A trip prepared through supplier adapters and a signed Commit Manifest with each leg's price clocks and evidence grade. Nothing is booked |
| `POST /v1/trips/revalidate` | 0.05 USDC | Fresh prices and availability. A material change supersedes the manifest |
| `POST /v1/trips/commit` | 0.50 USDC | Commits the exact manifest hash the agent approved. A leg is confirmed only after an independent read-back, and a timeout becomes `COMMIT_STATUS_UNKNOWN` instead of a retry |
| `POST /v1/trips/recover` | 0.25 USDC | Cancels what can still be cancelled inside limits set before payment, and reports what cannot |

A trip belongs to the payer address that prepared it, or to the sandbox session it was prepared in.
`revalidate`, `commit` and `recover` refuse anyone else with `403 NOT_TRIP_OWNER` before any payment settles.
A trip prepared on one network can't be acted on from the other.

The TestNet sandbox serves the same routes under `/sandbox/v1` with TestNet USDC. Intyr settles each payment
before any supplier work starts. A settlement with an unknown result returns `202` with `payment_state` and
`payment_txid`, never a second `402`. Discovery is at `/.well-known/x402` and `/llms.txt`.

## Try it

Without a wallet, the sandbox sponsors TestNet calls under an anonymous session:

```sh
curl -s -c jar -X POST https://intyr.timjosh507.workers.dev/sandbox/session
curl -s -b jar -X POST https://intyr.timjosh507.workers.dev/sandbox/v1/trips/check \
  -H 'content-type: application/json' -d @examples/agent/requests/check.json
```

With a TestNet wallet, the reference agent pays the `402` itself using only the stock `@x402/fetch` and
`@x402/avm` packages:

```sh
pnpm install
pnpm --filter @intyr/example-agent agent check requests/check.json --sandbox
```

See [examples/agent/README.md](examples/agent/README.md) for funding, opt-in and the example requests. In the
browser, `/app/demo` runs seeded failure scenarios end to end: a rejected flight, a hotel timeout, a
non-refundable leg.

## Check a record yourself

```sh
pnpm --filter @intyr/verifier verify <manifest_id> --sandbox
```

The verifier checks the Ed25519 signature against the published key at
`/.well-known/intyr-signing-keys.json` and recomputes the payload hash and Merkle roots. It then reads the
anchor note and every listed USDC payment from public Algorand nodes. It never asks Intyr's server whether a
record is valid. Pass `--key` to pin the key from a source you trust, and `--json` for the full report. It
exits 0 only for `PROOF_VERIFIED`. The public page `/verify/<manifest_id>` runs the same verifier in your
browser against Algorand.

A verified record shows that Intyr signed exactly this content, that it existed unchanged at the anchor round,
and that the listed payments happened as recorded. It does not show that a supplier kept a booking, or that
supplier or caller data is true.

To check the paid surface itself:

```sh
pnpm --filter @intyr/verifier check-402            # Mainnet /v1; add --testnet for the sandbox
```

It calls every paid route with an empty body and no payment, the way the facilitator's x402 Doctor and
listing refresh do. Each route must answer a `402` before it validates the body. The `402` must carry x402
V2, the full-hash Algorand network id, USDC, a price a stock client will pay, one payTo, the challenge tag, a
fee payer and a Bazaar example that passes the route's own schema. The body check belongs to the paid retry,
before settlement, so a request that would be refused is never charged.

## Status on 2026-09-30

| Part | State |
|---|---|
| x402 payment ladder, TestNet sandbox, commit saga, reconciler, recovery | running at the live URL |
| Mainnet routes under `/v1` | live. They pay to `EXWYXCAPJ7BUVKANGFMNTALTCTFJNV2AYKB3ERKVVKRXOJJREGQ5NJBKUI` in USDC (ASA 31566704) |
| Suppliers | a seeded fault simulator for the demo failures. Duffel test mode and LiteAPI sandbox run live for prepare and revalidate. Their offers score below the readiness bar, so a person approves a real sandbox commit (policy `sandbox-supplier-v1`) |
| Real bookings | none. No production supplier is connected, and each record states its evidence grade (`SIMULATED`, `CALLER_ASSERTED`, `SUPPLIER_SANDBOX`) |
| Algorand anchors | enabled on Mainnet and TestNet, from funded anchor accounts published in `/.well-known/intyr-signing-keys.json`. Records created before anchoring was enabled stay unanchored and verify as `PROOF_PARTIAL` |
| Guarantees | none. Every record carries `assurance.mode: NONE` |

## How it is built

One Cloudflare Worker (Hono) serves the API, the UI and the discovery files, with D1 for storage and a cron
that reconciles unknown payments, unknown commits and pending anchors.

| Package | What it holds |
|---|---|
| `packages/core` | Vocabulary, zod wire schemas, RFC 8785 canonical JSON, Ed25519 signing with domain-separated contexts, the state machines, the decision kernel gates, the planner, the saga step and the manifests |
| `packages/adapters` | The supplier adapter contract, Duffel flights, LiteAPI hotels, caller-supplied legs and the seeded hostile simulator |
| `packages/chain` | Algorand networks, note formats, note transactions, confirmation reads, anchor checks and USDC transfer reads |
| `packages/verifier` | The offline verifier library and CLI. Browser safe |
| `packages/eval` | The proof campaign: baseline arms, the Intyr arm, an independent auditor and the metrics |
| `apps/api` | The Worker: x402 resource server, payment ladder, trip store, commit saga, reconciler |
| `apps/web` | The UI: landing, trips queue, trip rails, approvals, demo and the proof pages |
| `examples/agent` | A reference x402 client |

Every gate returns one of `ACT`, `NO_ACTION`, `UNKNOWN`, `REFUSE` or `MANUAL_REVIEW` with named reason codes,
in a hash-chained decision log. Choosing not to act gets recorded just like acting does.

## Evidence

Campaign 001 ran eleven fault cells on the seeded simulator against a naive agent, a careful script and
Intyr, 110 runs each. It was pre-registered in git before any run. The results are in
[evidence/campaign-001/RESULTS.md](evidence/campaign-001/RESULTS.md), worst finding first.

- Intyr lost one cell (F10) to the careful script. It committed a cheaper hotel that refused every
  cancellation ahead of a flight that was refused, and reported the stranded hotel accurately.
- It matched the script in the other ten cells.
- The naive agent ended consistent in 36 percent of runs, against 100 percent for the script and 92 percent for
  Intyr.

The pre-registered headline, "more reliable than a careful script", is not supported. The claim that stands is
that Intyr gives an agent the careful script's behaviour as one paid call per step, 2.9 calls per trip, with
signed records, and matched it in ten of eleven cells.

A real-supplier sandbox trip (record `man_6e12c241db89cf1968e97636`) committed cleanly. A person approved it,
then Duffel test mode and the LiteAPI sandbox each confirmed their leg on read-back. The bookings are
supplier test orders, not real travel.

The first attempt before it (record `man_4fce63d207b53b0a5def9130`) ended `RECOVERY_FAILED`. A non-refundable
LiteAPI sandbox hotel confirmed, then Duffel test mode rejected the flight, and cancelling the hotel would
have cost more than the approved headroom. The signed record states the 192.36 EUR left stranded in the
sandbox. Both causes are fixed, and [docs/SUBMISSION.md](docs/SUBMISSION.md) has the details.

## Develop

```sh
pnpm install
pnpm check        # typecheck and test every package
```

Node 22 or newer and pnpm 11.

## More

- [docs/web-ui.md](docs/web-ui.md): every UI route, how each state renders, and a reviewer path through the UI
- [docs/evidence/ui/](docs/evidence/ui/): screenshots of live TestNet sandbox runs on seeded simulated suppliers
- [apps/web/README.md](apps/web/README.md): developing, building and testing the web app
- [docs/SUBMISSION.md](docs/SUBMISSION.md): challenge submission answers
- [docs/VIDEO_SCRIPT.md](docs/VIDEO_SCRIPT.md): demo video script
- [docs/ELECTRIC_CAPITAL.md](docs/ELECTRIC_CAPITAL.md): ecosystem registration

## License

MIT is declared in `package.json`. A LICENSE file will be added once the owner confirms the choice.
