# Web UI

The web app is the reference client and oversight console for the Intyr API. The product is the x402-paid API. The UI shows what the API decided and why, and never shows more than the server recorded. It is served by the same Cloudflare Worker as the API, so the landing page, the sandbox and the verifier share one origin with the paid routes.

Screenshots of live sandbox runs of every demo scenario are in [docs/evidence/ui](evidence/ui). They were captured on 2026-09-30 against the deployed TestNet sandbox with seeded simulated suppliers.

## Routes

| Route | Who it is for | What it shows |
|---|---|---|
| `/` | Anyone evaluating Intyr | What Intyr does, how check, prepare, commit and recover work, what a receipt proves and what it does not, live prices read from the API, and the limits of this release |
| `/docs/quickstart` | Agent developers | Discovery files, a `POST /v1/trips/check` example, the 402 challenge, a TypeScript client using `@x402/fetch` and `@x402/avm`, how to read `payment_state`, and the decision outcomes |
| `/verify`, `/verify/:manifestId` | Anyone holding a manifest id or file | The proof page: claim sentence, proof state, the checks that ran, what the record proves and what it does not, environment and supplier labels, anchors, signing key, and a command to rerun verification |
| `/evidence`, `/evidence/:runId` | Reviewers | The canonical run and the TestNet campaign, or an honest "not published yet" when a run does not exist |
| `/replay/:runId` | Presenters | A recorded run stepped through under a fixed "Captured, not live" banner |
| `/app` | The sandbox session holder | The trips queue. Work that needs a person comes first, then work in progress, then finished trips. There are no stat tiles or charts |
| `/app/trips/new` | The sandbox session holder | Prepare a trip through Duffel test mode and the LiteAPI sandbox (priced in EUR), or check offers an agent already found without calling any supplier |
| `/app/trips/:tripId` | The sandbox session holder | The verdict strip, one rail per leg across a commit boundary, the recovery timeline, the decision log, money and the receipt |
| `/app/trips/:tripId/approve` | The person in the session | The approval sheet. The decision is bound to the manifest hash, and no approval link is ever returned to an agent |
| `/app/demo` | Anyone | Server-run scenarios end to end, plus presets you commit yourself |

The sandbox needs no account, email or wallet. `POST /sandbox/session` sets an anonymous HttpOnly cookie that scopes trips for 24 hours. Every sandbox call runs on Algorand TestNet, and the x402 fee is sponsored by the server, so responses carry `payment_state: "SPONSORED"` and no USDC moves. Only the `/v1` routes charge real USDC on Mainnet.

## How states render

The UI takes every name from the core vocabulary in `packages/core/src/vocab.ts`. A unit test fails when a trip state, component state, decision outcome, proof state, preparation mode, evidence grade, leg class or reason code has no UI copy.

- Success tone only for verified states. A trip shows the success tone only in `COMMITTED`, and a leg only in `CONFIRMED`, which the server sets after a supplier read confirms the booking.
- `ACT` means authorized, not done. It renders with an arrow in the info tone, never as a green check.
- `UNKNOWN` never looks like failure or success. A trip in `COMMIT_STATUS_UNKNOWN` gets a filled dark verdict strip with the fixed sentence "We have not confirmed whether the supplier completed this. Do not retry. Intyr is checking and will update this trip." No enabled control retries, commits or recovers while it shows.
- `REFUSE` is a calm explanation with the reason in plain words and the code in mono, not an error banner.
- `NO_ACTION` is recorded and shown in the decision log, so a reader sees what Intyr correctly did not do.
- `MANUAL_REVIEW`, `RECOVERING` and `RECOVERY_FAILED` get filled strips that are stronger than `COMMITTED`.
- Supplier-authored text appears only under "Supplier notes" as plain text and never feeds a decision.

## Trip rails

Each leg is one rail. The dashed vertical line is the commit boundary. Legs are drawn in the server's commit order, with legs that can be undone first and the irreversible leg last.

Left of the boundary shows how firmly the supplier prepared the leg:

| Drawing | Meaning |
|---|---|
| Solid bar, filled end | Held by the supplier with a price guarantee (`HARD_HOLD`) |
| Solid bar, hollow end | Held, price can move (`SOFT_HOLD`) |
| Hatched bar | Price checked, nothing held (`REVALIDATED`) |
| Thin dashed line | Booked and paid only at commit (`INSTANT_COMMIT_ONLY`) |
| Short bar ending in a bar | Unavailable or not supported |

Right of the boundary shows what the supplier confirmed after commit:

| Drawing | Meaning |
|---|---|
| Green bar with a check | Confirmed by a read after the booking (`CONFIRMED`). A square end marks an irreversible leg |
| Dashed bar with a question mark | Not confirmed either way (`COMMIT_STATUS_UNKNOWN`) |
| Red bar ending in a bar | The supplier rejected the booking (`COMMIT_FAILED`) |
| Grey bar with a hollow end | Cancelled during recovery |
| Short dark bar with a ring | Booking sent, waiting for the supplier |

Every rail also carries its leg class and evidence grade in words, for example "Simulated supplier" or "Supplier sandbox (test mode)", and screen readers get a one-sentence summary of each leg.

## Proof in the browser

`/verify/:manifestId` runs `@intyr/verifier` in the browser. It checks the Ed25519 signature against `/.well-known/intyr-signing-keys.json` and the content roots with WebCrypto, then reads the anchor and any payments from a public Algorand node, never from Intyr's server. A browser result of `SIGNATURE_INVALID` or `HASH_MISMATCH` overrides whatever the server says. The server result from `POST /v1/manifests/verify` is shown below it, and for TestNet ids the page falls back to `/sandbox/v1`.

Today every sandbox manifest verifies as `PROOF_PARTIAL`, "Signature valid, not anchored": the signature and roots check out, and the TestNet anchor account is not funded yet, so no anchor transaction exists. The page says that plainly and does not list the anchor claim under "What this proves".

## Reviewer path through the UI

1. Open `/app/demo` and press "Run it" on "The flight is rejected after the hotel and transfer confirmed". The trip ends `RECOVERED`: the flight failed, the hotel and transfer were cancelled inside their free windows, nothing is left booked.
2. Run "The hotel times out" and keep the trip open. It shows `COMMIT_STATUS_UNKNOWN` with the fixed copy, then turns `COMMITTED` about a minute later when a supplier read finds the booking. Intyr never retries the write.
3. Press "Open proof" on a finished trip to reach `/verify/:manifestId` and see the in-browser check.
4. The link "Simulator order list" on a seeded trip opens the simulator's own record of orders, which is independent of Intyr's trip record.

## Limits of this release

- Suppliers are Duffel and LiteAPI in test mode, plus Intyr's seeded simulator. No real travel is booked.
- Real Duffel and LiteAPI test offers can be prepared and revalidated. Their readiness score is below the commit threshold, so commit does not run on them without a person's decision.
- No bond, insurance or protection covers any trip (`assurance.mode` is `NONE`).
- Approvals exist only inside the anonymous sandbox session. There are no organization accounts, API keys or roles in this release.

## Development

See [apps/web/README.md](../apps/web/README.md).
