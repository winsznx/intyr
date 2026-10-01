# Demo video script (3 to 4 minutes)

Rules for the recording:
- Record real surfaces only: the live site, a real terminal, the public explorer. No mockups, no added window
  chrome, no sped-up typing.
- Keep the sandbox and environment labels visible in every frame where they appear.
- If a live dependency fails during a take, re-record the take. Do not stitch in footage from another run
  without labeling it "Replay".

Before recording, open these in tabs:
1. https://intyr.timjosh507.workers.dev/ (landing)
2. https://intyr.timjosh507.workers.dev/app/demo
3. A terminal in the repo root with `pnpm install` already done, and `jq` installed
4. The Algorand explorer: https://allo.info for Mainnet, https://lora.algokit.io/testnet for TestNet
   (`testnet.allo.info` does not resolve)

## Script

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 to 0:15 | `/app/demo`, scenario "rejected-flight" finished | Show the trip with the hotel and transfer cancelled after the flight was rejected | "An agent booked a hotel and a transfer, then the flight was rejected. Without help, that's half a trip and money stuck with suppliers." |
| 0:15 to 0:40 | Terminal | Run `curl -si -X POST https://intyr.timjosh507.workers.dev/v1/trips/check \| grep -i '^payment-required:' \| cut -d' ' -f2 \| tr -d '\r' \| base64 -d \| jq '.accepts[0] \| {network, asset, amount, payTo, tag: .extra.tag}'` | "Every step is a paid x402 call. No account and no API key. The 402 names the price, 0.10 USDC on Algorand Mainnet, the pay-to address and the challenge tag." |
| 0:40 to 1:10 | Explorer, then terminal | Open RUN-001's payment https://allo.info/tx/2MD7RMXDHTLVE76ZNTAOZKZCYEPLF7AIBBOAGZQEO6JOFQLNLVPA, then run `pnpm --filter @intyr/verifier verify pln_357c45b828fabcb25b5e271e`. Don't pay again | "A stock x402 client paid 10 cents on Mainnet and got a signed commit plan. This was our own team payment, from a wallet we funded. The plan was anchored on Algorand two rounds later, and the verifier checks it straight from the chain." |
| 1:10 to 1:40 | `/app/demo`, start "timeout-hotel" | Start the scenario and let it reach `COMMIT_STATUS_UNKNOWN` | "Here the hotel times out. Intyr doesn't know if it booked, so it says unknown and does not retry. Retrying is how agents double-book." |
| 1:40 to 2:05 | Same trip | Wait for the reconciler to read the supplier and move the trip on. Open the decision log | "Intyr reads the supplier's own record, then moves on. Every decision is logged with a reason, including the ones where it chose to do nothing." |
| 2:05 to 2:35 | Terminal | Download RUN-001's record, add one cent to a copy, and post both to the public verify route: `curl -s https://intyr.timjosh507.workers.dev/v1/manifests/pln_357c45b828fabcb25b5e271e \| jq '{signed: .signed}' > receipt.json`, then `jq '.signed.payload.exposure.total_minor += 1' receipt.json > tampered.json`, then for each file `curl -s -X POST https://intyr.timjosh507.workers.dev/v1/manifests/verify -H 'content-type: application/json' --data @receipt.json \| jq .proof_state`. It prints `PROOF_VERIFIED`, then `HASH_MISMATCH` | "The record is signed and anchored on Algorand. Change one cent and the check fails." |
| 2:35 to 2:55 | Terminal | Run `pnpm --filter @intyr/verifier verify <manifest id> --sandbox` on the same demo trip | "You don't have to trust our server. This verifier checks the signature and reads the anchor straight from public Algorand nodes." |
| 2:55 to 3:15 | `evidence/campaign-001/RESULTS.md` on GitHub | Scroll the "worst first" list and the numbers table | "We pre-registered a test against a naive agent and a careful script, across ten fault patterns and one healthy control. The naive agent stranded money in most runs. Intyr matched the careful script in ten of the eleven cells and lost one, where it stranded a hotel that refused to cancel. We report that first." |
| 3:15 to 3:30 | Landing, limits line | Hold on the limits text | "Suppliers here are sandbox and simulated, and nothing real was booked. The payment and the anchors are real Algorand transactions, and the one Mainnet payment was ours." |

## Notes

- Mainnet is live, and RUN-001 is the Mainnet payment to show. Don't make another paid call for the video.
  More team payments would count as self-payment volume.
- The `/app/demo` scenarios run on the TestNet sandbox with seeded simulated suppliers. Keep the sandbox banner
  in frame and say "simulated" when a demo trip is on screen.

## Checks before uploading

- Every number on screen came from the live system in this recording.
- No frame shows a mnemonic, a private key, `~/.intyr/keys.json`, `.dev.vars` or a wallet seed phrase.
- The limits line is on screen at the end.
