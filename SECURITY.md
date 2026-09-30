# Security

Intyr takes USDC payments on Algorand Mainnet and signs records that people rely on. Please report anything
that could move money wrongly, forge or alter a record, or let one caller act on another caller's trip.

## Reporting

Use GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a
vulnerability". Please don't open a public issue for a security problem. Reports are answered on a best-effort
basis while the project is in its challenge release.

A useful report says which route or package is affected, what an attacker can do, and the steps or request
bodies that show it.

## In scope

- The x402 payment ladder in `apps/api/src/payments`: settlement, replay, the unknown-settlement path and the
  checks that run before a charge.
- Trip ownership and the network separation between `/v1` (Mainnet) and `/sandbox/v1` (TestNet).
- Record signing and verification in `packages/core` and `packages/verifier`, and the published key at
  `/.well-known/intyr-signing-keys.json`.
- Anchor transactions and their note format in `packages/chain`.

## Out of scope

- The GoPlausible facilitator, the Algorand nodes and the supplier APIs, which have their own disclosure
  processes.
- The seeded simulator on the sandbox, which is designed to misbehave.
- Load or volume testing against the live Worker.

## Testing etiquette

- Keep Mainnet payments to the published prices, and don't pay to probe more than you need to.
- Only test against trips you created.
- Never send payments meant to inflate the challenge leaderboard.

## Keys

Records are signed with the Ed25519 key published at `/.well-known/intyr-signing-keys.json`. If that key is
ever retired, the document will mark it `revoked` and publish its replacement, so records signed earlier stay
checkable.
