# Contributing

## Setup

Node 22 or newer (CI uses Node 24, which the API tests need for `node:sqlite`) and pnpm 11.

```sh
pnpm install
pnpm check        # typecheck and test every package
```

`pnpm --filter <package> test` runs one package. The API runs locally with `pnpm --filter @intyr/api dev` once
`apps/api/.dev.vars` exists. Copy the variable names from `.dev.vars.example` and keep the values out of git.

## How the code is organised

The package map is in the README. A few rules hold everywhere:

- Names for states, outcomes, reason codes, evidence grades and simulator scenarios come from
  `packages/core/src/vocab.ts`. Add a name there first, then use it.
- Money is an integer in minor units with a currency code. Prices on the wire are atomic USDC strings.
- A decision that stops an action is recorded like one that allows it, with a reason code.
- A supplier write is never counted as confirmed until the booking has been read back.
- Anything signed goes through `packages/core/src/sign.ts` with its own signature context.

## Changes

- Keep commits small, and write their messages in the conventional form (`feat(core): ...`, `fix(api): ...`).
- Add or update tests with the change. `pnpm check` must pass before a pull request.
- Don't commit secrets, `.dev.vars` or wallet files. The pre-commit guard and `.gitignore` refuse the common
  cases.
- Describe behavior honestly in docs. A claim needs a test, a record or a live response behind it.
