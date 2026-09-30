# Campaign 001 results

Pre-registration: `packages/eval/EVAL_CAMPAIGN.md`, committed in `c14c8b6` before any run (sha256
`fb6038c8bd37173ff4a4f805c2e577e981a416ce9e1b7322b54fae1be0d6c722`). The same hash was later anchored on
Algorand TestNet in transaction `WHP6YBEIU3B4QR3RMA2UHO6R2FVHQOJ6PHAAKETTJZPF3GXXWWNA` (round 67823189,
note `intyr:prereg:v1:<hash>`, sender `MH22ASOZ...`, the TestNet payer account). The git commit predates every
run. The chain anchor came after the in-process runs and proves the committed file was not changed afterwards.

Every supplier in this campaign is the seeded simulator. Nothing here is a live booking. The table is in
`SUMMARY.md`, per-run records in `results.jsonl` (B0, B1) and `t-results.jsonl` (T), and every HTTP exchange of
the T arm in `t-shards/*/t-transcripts.jsonl`.

## What we found, worst first

1. **Intyr loses one cell to the careful script.** In F10 the hotel accepts the booking but refuses every
   cancellation, and the flight is refused. Nothing in either leg's quote says the hotel will refuse to
   cancel, so both arms treat both legs as reversible. Intyr orders equal-risk legs by earliest expiry and then
   price, so it commits the cheaper hotel first. The flight is refused, the hotel cancel is refused, and the trip
   ends `RECOVERY_FAILED` with the hotel stranded. That happened in 9 of 10 runs, leaving on average $163.78 of
   live hotel orders per trip in that cell. The independent script commits in request order (flight first),
   the flight is refused before anything is booked, and it ends with nothing booked in 10 of 10. Intyr's
   report was accurate every time: it said `RECOVERY_FAILED` and named the stranded leg. It did not hide the
   loss, but it did not avoid it either. The ordering is a tie-break, not a guarantee, and this cell shows it
   can go either way.
2. **Everywhere else Intyr matches the careful script.** In the other ten cells, including a lost response after
   the supplier booked (F5), a lost response where a blind retry double-books (F8), an asynchronous acceptance
   that later fails (F4) and a response that claims a booking that does not exist (F7), Intyr ends consistent in
   every run, with no duplicates and no belief that contradicts the supplier.
3. **The naive agent fails as expected.** B0 ends consistent in 36% of runs, creates 20 duplicate orders and
   holds 20 beliefs that contradict the supplier.

## Decision rule

The pre-registered rule required T to beat B1 on consistent terminal rate in at least 6 of the 10 fault cells
and lose in none. T beats B1 in none and loses in one (F10). The headline claim that Intyr is more reliable than
a careful script is therefore **not supported**. Per the rule, the claim is narrowed to what the evidence shows:

> Under ten documented supplier fault patterns, a naive agent leaves bookings stranded or duplicated in most
> runs. A careful engineer's script avoids that. Intyr provides the same careful behaviour as one paid call per
> step, 2.9 calls per trip from the caller's side, with signed manifests and decision records, and it matched
> that script in ten of eleven cells and lost one.

## Numbers

| Arm | Runs | Consistent terminal rate | Completion when feasible | Orphan USD per 100 trips | Duplicate orders | Belief mismatches | Calls per trip |
|---|---|---|---|---|---|---|---|
| B0 naive | 110 | 36% | 25% | 24,914.94 | 20 | 20 | 3.6 supplier calls |
| B1 careful script | 110 | 100% | 75% | 0.00 | 0 | 0 | 8.7 supplier calls, 431 lines of the caller's own code |
| T Intyr | 110 | 92% | 75% | 1,488.92 | 0 | 0 | 2.9 HTTP calls to Intyr |

"Completion when feasible" is 75% for both B1 and T because neither completes F1 (an 8% reprice between quote
and payment): the script aborts on any price move, and Intyr's commit hits the supplier's `price_changed` and
unwinds. A caller who wants F1 to complete has to accept the new price and commit again.

## Pre-fix pass and harness faults (negative evidence)

- The first T pass ran against Worker 706e15b2, whose unknown-state reconciler skipped every sponsored sandbox
  trip. There, 2 of 10 F4 trips stayed `COMMIT_STATUS_UNKNOWN` with the hotel booked, and T's consistent rate was
  97% over 68 runs. That pass is kept, unmerged, in `t-prefix-706e15b2/`. The reconciler was fixed in ede2c708,
  and the full T arm was rerun against it.
- The live Worker was redeployed during the rerun (ede2c708, then 4672eef3). The later deploy changed the Duffel
  age fix, sandbox supplier policy, the Mainnet payTo and a LiteAPI rate preference, none of which run in
  simulator trips. TestNet manifest anchoring was switched on during the run, which added about 3 seconds per call
  and does not change supplier behaviour.
- The simulator used to keep each trip's state in one record. Concurrent preparation of two legs lost one offer
  and made healthy trips fail. That was found by this campaign's first T attempt, fixed in `a37927a`, and every T
  run here postdates the fix.
- One pre-fix T run was excluded because a duplicate harness process reused its seed (logged in
  `t-prefix-706e15b2/harness-exclusions.jsonl`). Harness network faults in the rerun are logged in
  `t-shards/*/t-harness-errors.jsonl`, and each affected trip was rerun on a fresh seed.

## What this does not show

It says nothing about how often these faults happen with real suppliers, and nothing about live bookings. Real
supplier sandbox runs (Duffel test mode, LiteAPI sandbox) are recorded separately in
`evidence/supplier-sandbox/`.
