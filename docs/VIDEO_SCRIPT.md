# Demo video script (3 to 4 minutes)

Rules for the recording:
- Record real surfaces only: the live site, a real terminal, the public explorer. No mockups, no added window
  chrome, no sped-up typing.
- Keep the sandbox and environment labels visible in every frame where they appear.
- Pick the demo seed before recording and keep it for every take.
- If a live dependency fails during a take, re-record the take. Do not stitch in footage from another run
  without labeling it "Replay".

Before recording, open these in tabs:
1. https://intyr.timjosh507.workers.dev/ (landing)
2. https://intyr.timjosh507.workers.dev/app/demo
3. A terminal in the repo root with `pnpm install` already done
4. The Algorand explorer (https://allo.info for Mainnet, https://testnet.allo.info for TestNet)

## Script

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 to 0:15 | `/app/demo`, scenario "rejected-flight" finished | Show the trip with the hotel and transfer cancelled after the flight was rejected | "An agent booked a hotel and a transfer, then the flight was rejected. Without help, that's half a trip and money stuck with suppliers." |
| 0:15 to 0:40 | Terminal | Run `curl -i -X POST https://intyr.timjosh507.workers.dev/v1/trips/check -H 'content-type: application/json' -d @examples/agent/requests/check.json` and point at the `402` and the `payment-required` header | "Every step is a paid x402 call. No account and no API key. The 402 names the price in USDC on Algorand, the pay-to address and the challenge tag." |
| 0:40 to 1:10 | Terminal | Run `pnpm --filter @intyr/example-agent agent check requests/check.json --network mainnet --role mainnet_payer`, then open the payment txid in the explorer | "A stock x402 client pays 10 cents and gets a signed commit plan: which leg to commit first, what can't be undone, and a verdict." |
| 1:10 to 1:40 | `/app/demo`, start "timeout-hotel" | Start the scenario and let it reach `COMMIT_STATUS_UNKNOWN` | "Here the hotel times out. Intyr doesn't know if it booked, so it says unknown and does not retry. Retrying is how agents double-book." |
| 1:40 to 2:05 | Same trip | Wait for the reconciler to read the supplier and move the trip on. Open the decision log | "Intyr reads the supplier's own record, then moves on. Every decision is logged with a reason, including the ones where it chose to do nothing." |
| 2:05 to 2:35 | `/verify/<manifest id>` | Show the checks. Use "Tamper with a copy" and show the result flip to `HASH_MISMATCH` | "The final record is signed and anchored on Algorand. Change one cent and the check fails." |
| 2:35 to 2:55 | Terminal | Run `pnpm --filter @intyr/verifier verify <manifest id>` | "You don't have to trust our server. This verifier checks the signature and reads the anchor and payments straight from public Algorand nodes." |
| 2:55 to 3:15 | `/evidence` | Show campaign-001 and the payer classes | "We ran the same faults against a naive agent and a careful script, and an auditor counted what each one left behind." |
| 3:15 to 3:30 | Landing, limits line | Hold on the limits text | "Suppliers here are sandbox and simulated. Nothing real was booked. Payments and anchors are real Algorand transactions." |

## If Mainnet is not live when you record

Replace the 0:15 to 1:10 rows with the TestNet sandbox, and label them on screen as TestNet:

```sh
curl -i -X POST https://intyr.timjosh507.workers.dev/sandbox/v1/trips/check \
  -H 'content-type: application/json' -d @examples/agent/requests/check.json
pnpm --filter @intyr/example-agent agent check requests/check.json --sandbox
```

Then say "on TestNet" instead of "on Algorand" in the voiceover, and don't show a Mainnet explorer.

## Checks before uploading

- Every number on screen came from the live system in this recording.
- No frame shows a mnemonic, a private key, `~/.intyr/keys.json`, `.dev.vars` or a wallet seed phrase.
- The limits line is on screen at the end.
