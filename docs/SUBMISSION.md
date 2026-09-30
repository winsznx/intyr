# Intyr: Algorand Global x402 Challenge submission

This file holds the answers for the submission form. Every line is either true of the running system today or
marked `[OWNER]` where only the owner can supply it. Update the marked lines before submitting. Do not
replace them with guesses.

## Project name

Intyr

## One-liner

When a supplier fails halfway through an agent's multi-supplier booking, Intyr unwinds what can still be
undone and says exactly what cannot. Agents pay for each step in USDC over x402 on Algorand, with no account,
and every step ends in a signed record anyone can check against the chain.

## Description

An AI agent that books a trip calls several suppliers in a row: a flight, a hotel, a transfer. If the third
call fails after the first two succeeded, a naive agent is left holding half a trip. It may not even know
whether the failed call booked anything. Intyr sits between the agent and the suppliers and sells each step
of a safe commit as a paid x402 call.

- `check` takes legs the agent already found and returns a signed commit plan. It gives the order to commit
  in (reversible legs first, irreversible legs last), how firm each hold is, what cannot be undone, and a
  verdict: commit now, revalidate first, needs approval, or do not commit.
- `prepare` fetches and revalidates each leg through a supplier adapter. It returns a signed Commit Manifest
  that records every leg's price clocks and evidence grade. Nothing is booked.
- `revalidate` re-checks a prepared trip. Any material change supersedes the manifest.
- `commit` commits the exact manifest hash the agent approved. A timeout or a lost response becomes
  `COMMIT_STATUS_UNKNOWN` and is reconciled by reading the supplier, never retried blindly. A component
  counts as confirmed only after an independent read-back.
- `recover` cancels what can still be cancelled inside limits set before payment. It keeps what cannot be
  undone and reports it.

Each decision is a hash-chained record with an outcome (`ACT`, `NO_ACTION`, `UNKNOWN`, `REFUSE` or
`MANUAL_REVIEW`) and named reason codes, so inaction is as auditable as action. Final records are Ed25519-signed
over RFC 8785 canonical JSON and anchored on Algorand as a note transaction. The open-source verifier in
`packages/verifier` checks a record against the published key and public Algorand nodes, without asking
Intyr's server.

What is real and what is not, today:

| Part | Status on 2026-09-30 |
|---|---|
| x402 payment ladder (settle before any supplier work, txid persisted, 202 with `payment_state` for an unknown settlement) | running on the TestNet sandbox |
| Mainnet routes under `/v1` | live since 2026-09-30. Every paid route answers a Mainnet USDC 402 carrying the challenge tag, or refuses an unknown trip before charging (`check-402 --mainnet` passes all five) |
| Suppliers | seeded fault simulator for the demo failures. Duffel test mode and LiteAPI sandbox run live for prepare and revalidate. Their offers score below the readiness bar, so a person approves a real sandbox commit under policy `sandbox-supplier-v1` |
| Real bookings | none. No production supplier is connected, and the manifests say so in their evidence grade |
| Algorand anchors | enabled on both networks. The Mainnet anchor account `X6RVK5VDE2KQOEWURVUWGAPNEL5FYFTJXJFODKO55MN3JRX4DBQTPQ4BDQ` is funded and published in `/.well-known/intyr-signing-keys.json`. Records created before anchoring was enabled stay unanchored and verify as `PROOF_PARTIAL` |
| Assurance or guarantees | none. `assurance.mode` is `NONE` in every record |

## Live endpoint

- Host: https://intyr.timjosh507.workers.dev
- Mainnet routes: `POST /v1/trips/{check,prepare,revalidate,commit,recover}`
- TestNet sandbox routes: `POST /sandbox/v1/trips/{check,prepare,revalidate,commit,recover}`
- Discovery: `GET /.well-known/x402` (x402 V2, tag `x402-global-challenge`), `GET /llms.txt`,
  `GET /.well-known/intyr-signing-keys.json`

## What each payment unlocks

| Route | Price | What the caller gets |
|---|---|---|
| `POST /v1/trips/check` | 0.10 USDC | A signed commit plan: commit order, per-leg hold strength, irreversible exposure and a verdict |
| `POST /v1/trips/prepare` | 0.25 USDC | A trip and a signed Commit Manifest with supplier clocks and evidence grades. Nothing is booked |
| `POST /v1/trips/revalidate` | 0.05 USDC | A manifest diff and a new or unchanged manifest |
| `POST /v1/trips/commit` | 0.50 USDC | A transaction manifest with per-leg confirmations read back from each supplier |
| `POST /v1/trips/recover` | 0.25 USDC | A recovery record with per-leg outcome and realized loss |

Prices stay at or below 1 USDC, because a stock x402 client refuses higher prices unless it is configured to
allow them. The sandbox mirrors carry the same prices in TestNet USDC (ASA 10458941).

## Who pays

Autonomous agents pay per action with a stock x402 client (`@x402/fetch` with `@x402/avm`). They need no
account, API key or custom header. `examples/agent` is a reference client built only from those packages.
Payments from wallets the team controls are labeled `INTERNAL_VALIDATION` in `GET /v1/stats/public` and are
never presented as adoption.

## payTo wallet on the leaderboard

- Mainnet: `EXWYXCAPJ7BUVKANGFMNTALTCTFJNV2AYKB3ERKVVKRXOJJREGQ5NJBKUI`, opted in to USDC (ASA 31566704) in
  transaction `W3LEVRM2YRLACV2DWAUDAL3XYPGE25SBPLZESAYDT66TRYMAOMGQ`, round 65550070. The same address appears
  in `/.well-known/x402` and in every Mainnet 402.
- TestNet sandbox: `ZBSIVWPNE3WGZBUTLNTGXJBBAAEWYVPHYQL2C2CGYFCLXEL2CWMNYTKTXA`

## Proof of a real Mainnet payment

RUN-001, on 2026-10-01, was a team-controlled payment, labeled `INTERNAL_VALIDATION` and not adoption:

- Payment: `2MD7RMXDHTLVE76ZNTAOZKZCYEPLF7AIBBOAGZQEO6JOFQLNLVPA`, round 65551497. It moved 0.10 USDC
  (ASA 31566704) from the team payer `HHHWQXWFW3S5MMYJXRCA4Y6XTMM4ESR26TYP3HHWXX27AUFUZCYEXK7OZQ` to the payTo,
  settled through the GoPlausible facilitator as a fee-paid atomic group.
  https://allo.info/tx/2MD7RMXDHTLVE76ZNTAOZKZCYEPLF7AIBBOAGZQEO6JOFQLNLVPA
- What it bought: a signed commit plan from `POST /v1/trips/check`, `pln_357c45b828fabcb25b5e271e`, payload
  hash `sha256:0cab926c4c011c0cef69089057c7362d47468c682cce4d94a02a415c63942ac0`.
- Anchor: `H5MV4IAUFZNDYW6YPUSQP7YVANXLRDOUXFCDTNOEBX6LD5DITGCQ`, round 65551499, two rounds after the
  payment. It was sent by the published Mainnet anchor account, with note `intyr:v1:<payload hash>`.
  https://allo.info/tx/H5MV4IAUFZNDYW6YPUSQP7YVANXLRDOUXFCDTNOEBX6LD5DITGCQ

Check it without trusting Intyr's server: `pnpm --filter @intyr/verifier verify pln_357c45b828fabcb25b5e271e`
returns `PROOF_VERIFIED`. The payment itself can be read from any Algorand indexer at the txid above.

## How to check a record yourself

```sh
pnpm install
pnpm --filter @intyr/verifier verify <manifest_id> --sandbox            # add --key <x> to pin the key
```

The verifier checks the Ed25519 signature against the published key. It then checks the payload hash and the
component and decision Merkle roots, reads the anchor note from a public Algorand indexer, and matches every
listed payment against the USDC transfer on chain. It exits 0 only for `PROOF_VERIFIED`.

## Evidence

The campaign question, arms, metrics and decision rule were committed to git before any run, in `c14c8b6`
(`packages/eval/EVAL_CAMPAIGN.md`, SHA-256 `fb6038c8bd37173ff4a4f805c2e577e981a416ce9e1b7322b54fae1be0d6c722`).
The same hash was anchored on TestNet later, in transaction `WHP6YBEIU3B4QR3RMA2UHO6R2FVHQOJ6PHAAKETTJZPF3GXXWWNA`
at round 67823189, with note `intyr:prereg:v1:<hash>`. The anchor was sent from the TestNet payer account. The
git commit is what predates the runs. The anchor proves the committed file wasn't changed after that round.

Campaign 001 ran three arms, 110 runs each, over eleven fault cells on the seeded simulator: a naive
sequential agent (B0), a careful independent script (B1) and Intyr over HTTP (T). An auditor read the
simulator's own order list. Results are in `evidence/campaign-001/RESULTS.md`, worst finding first:

1. Intyr lost one cell to the careful script. In F10 the hotel refuses every cancellation and the flight is
   refused. Intyr commits equal-risk legs by earliest expiry and then price, so it committed the cheaper hotel
   first. In 9 of 10 runs the trip ended `RECOVERY_FAILED` with the hotel stranded, $163.78 per trip on
   average. The script commits in request order, flight first, and ended with nothing booked in 10 of 10.
   Intyr's report was accurate every time.
2. In the other ten cells Intyr matched the careful script, with no duplicates and no belief contradicting the
   supplier. That includes a lost response after booking, a blind-retry double-book trap, an asynchronous
   failure and a false confirmation.
3. The naive agent ended consistent in 36 percent of runs, with 20 duplicate orders.

| Arm | Consistent terminal rate | Completion when feasible | Orphan USD per 100 trips | Duplicates | Caller effort |
|---|---|---|---|---|---|
| B0 naive | 36% | 25% | 24,914.94 | 20 | 3.6 supplier calls |
| B1 careful script | 100% | 75% | 0.00 | 0 | 8.7 supplier calls, 431 lines of its own code |
| T Intyr | 92% | 75% | 1,488.92 | 0 | 2.9 calls to Intyr |

The pre-registered headline, "more reliable than a careful script", is not supported. Per the pre-registered
rule, the claim is narrowed to this, quoted from RESULTS.md:

> Under ten documented supplier fault patterns, a naive agent leaves bookings stranded or duplicated in most
> runs. A careful engineer's script avoids that. Intyr provides the same careful behaviour as one paid call per
> step, 2.9 calls per trip from the caller's side, with signed manifests and decision records, and it matched
> that script in ten of eleven cells and lost one.

The F10 loss and the first real-supplier failure share one cause, the tie-break among equally risky legs.
Committing the weakest hold first is the recorded next change. It was not made during the campaign, so these
numbers describe the code that ran.

A real-supplier sandbox trip committed cleanly. It's trip `trp_0f0591dc5e1c0d4b920b33a9`, with transaction
manifest `man_6e12c241db89cf1968e97636`.
- Duffel test mode booked a flight and the LiteAPI sandbox booked a hotel. Both are test orders, not real
  travel.
- Each leg was confirmed by reading the booking back from the supplier (evidence tier E1).
- The trip ended `COMMITTED` with nothing stranded.
- The prepare gate scored readiness at 61, below the 70 bar. That score is an unvalidated prior. Under
  `sandbox-supplier-v1` the trip went prepare, then a person's approval, then commit.
- It ran on the sponsored TestNet sandbox, so no USDC moved for Intyr's fee.
- The commit call took 49 seconds end to end, because both suppliers are slow. An agent needs a long client
  timeout on commit.
The record verifies with `pnpm --filter @intyr/verifier verify man_6e12c241db89cf1968e97636 --sandbox`
(`PROOF_PARTIAL`, signed and intact, not yet anchored). Its four decisions are the whole trail: prepare, commit,
and one confirmation per leg.

The first real-supplier sandbox run went wrong, and it's kept as evidence. It's trip `trp_d261cfdcabc61cbc93f83adb`,
with transaction manifest `man_4fce63d207b53b0a5def9130`.
- A person approved the commit under `sandbox-supplier-v1`.
- The LiteAPI sandbox hotel confirmed on read-back.
- Then Duffel test mode rejected the flight with `born_on_does_not_match`: the adapter searched with a traveler
  age that didn't match the date of birth.
- The hotel rate was non-refundable, so cancelling it needed spend beyond the approved headroom. Intyr asked a
  person instead of spending.
- The trip ended `RECOVERY_FAILED`, with 192.36 EUR stranded in the sandbox, and the signed record says so. No
  real money moved.
The record verifies with `pnpm --filter @intyr/verifier verify man_4fce63d207b53b0a5def9130 --sandbox`. It
returns `PROOF_PARTIAL`, meaning it's signed and intact but not yet anchored.

The two causes are fixed. The Duffel search now uses the traveler's age on the travel date, and the LiteAPI
adapter prefers a refundable rate within the price cap. With a refundable rate, the hotel orders ahead of the
flight as reversible and can be cancelled if the flight fails. One planner change is recorded for later:
among legs that are equally irreversible, commit the weakest hold first. That would have tried the flight
before the hotel here.

## Demo video

`[OWNER: video link, 3 to 5 minutes]`. The script is in `docs/VIDEO_SCRIPT.md`.

## Repository

https://github.com/winsznx/intyr (public). License: `[OWNER: package.json says MIT, LICENSE file not added
yet]`.

Electric Capital registration: pull request https://github.com/electric-capital/open-dev-data/pull/3079 adds
`repadd Algorand https://github.com/winsznx/intyr #protocol` under the Algorand ecosystem. The steps are in
`docs/ELECTRIC_CAPITAL.md`.
