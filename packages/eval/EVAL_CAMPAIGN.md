# Campaign 001: pre-registration

Written and committed before any campaign run. Its sha256 is recorded in the git history before the first
results file exists, and is anchored on Algorand TestNet as soon as the anchor account is funded.

## Question

When one component of a multi-supplier trip misbehaves, does a trip committed through Intyr end in a
consistent state (every component booked exactly once, or nothing left booked) more often than the same
trip booked by a competent script, and does it leave less money stranded in live supplier orders?

## Arms

- **B0, naive.** Books components in request order, retries a commit once when the response is unclear,
  never reads status, never cancels. A floor, not the comparison that matters.
- **B1, competent.** Written by a separate agent session that saw only the supplier adapter contract
  (`packages/adapters/src/contract.ts`) and the harness contract (`packages/eval/src/types.ts`), never
  Intyr's kernel, saga or API. Its file hash is recorded in `run-manifest.json` for every run.
- **T, Intyr.** The deployed Worker's sandbox routes (`/sandbox/v1/trips/prepare`, `/commit`, `/recover`),
  called over HTTP by an external client with TestNet x402 payments.

## Exam

Eleven cells in `packages/eval/src/cells.ts`: a healthy control (C0) and ten fault cells (F1 to F10)
modelled on documented supplier behaviour: repricing between quote and payment, inventory gone at
commit, a refusal after another component confirmed, asynchronous acceptance that later fails, a lost
response after the supplier booked, a timeout with nothing booked, a response that claims a booking the
supplier never made, a lost response where a blind retry duplicates, and two cells where recovery is
limited by a non-refundable or non-cancellable component. Two trip shapes (flight and hotel; flight,
hotel and ground). Faults are fixed by the seed before a run.

Suppliers in this campaign are the seeded simulator. Every artifact says so. The simulator has no commit
idempotency, as Duffel does not, so a blind retry after a lost response creates a second order.

## Ground truth

An auditor (`packages/eval/src/auditor.ts`) reads the simulator's own order list after a settle window.
It never reads an arm's records to decide what happened. For T the order list is read through a read-only
sandbox route that returns the simulator store for a seed.

## Metrics

- **CTR**, consistent terminal rate: share of runs ending COMPLETE or UNWOUND.
- **ORPHAN_USD_PER_100**: value left in live orders of inconsistent trips, per 100 trips (sandbox-valued).
- **DUP_ORDERS**: live orders beyond one per component.
- **BELIEF_MISMATCH**: components where the arm's final belief contradicts the supplier. Honest UNKNOWN is
  counted separately.
- **COMPLETION_WHEN_FEASIBLE**: COMPLETE share over cells where a correct agent can finish (C0, F1, F5,
  F8). This guards against an arm that scores well by refusing everything.

## Predictions (made before the first run)

1. B0 ends inconsistent in F3, F5, F8 and F9 in both shapes, and believes a booking that does not exist
   in F7.
2. B1 matches T on most cells. Where they differ, T is ahead on F7 and F10 because it treats an
   unverified response as unknown and records non-actions rather than assuming.
3. T ends consistent in every cell except where the supplier refuses both commit and cancel (F10), where
   it ends in MANUAL_REVIEW with the stranded amount stated.
4. T and B1 both reach COMPLETION_WHEN_FEASIBLE of 100 percent.

## Decision rule

T supports the headline claim only if, across the ten fault cells, T's CTR is higher than B1's in at
least 6 cells and lower in none (exact sign test, p about 0.03). If T merely matches B1, the claim is
narrowed to what the evidence shows: the same safety as a careful script, delivered as a paid service
with verifiable receipts. If T is worse anywhere, that cell is reported first in the results.

## What this campaign cannot show

It measures behaviour under simulated faults. It says nothing about how often these faults happen with
real suppliers, and nothing about live bookings. Duffel test mode and LiteAPI sandbox runs, where keys are
available, are reported separately and labelled supplier sandbox.
