# @intyr/web

Vite, React 19 and React Router 8. The production build goes to `dist/` and is served by the API Worker through a Cloudflare assets binding with a single-page-app fallback, so the UI and the API share one origin. What each route does and how states render is in [docs/web-ui.md](../../docs/web-ui.md).

## Commands

```sh
pnpm --filter @intyr/web dev        # Vite on :5173, proxies /v1, /sandbox, /.well-known, /llms.txt and /openapi.json
pnpm --filter @intyr/web build      # typecheck, then build to apps/web/dist
pnpm --filter @intyr/web test       # unit tests (Node, no browser)
pnpm --filter @intyr/web typecheck
```

The dev server proxies API paths to `http://127.0.0.1:8787` (`wrangler dev` in `apps/api`). To develop against the deployed sandbox instead:

```sh
INTYR_API_ORIGIN=https://intyr.timjosh507.workers.dev pnpm --filter @intyr/web dev
```

## Layout

| Path | Contents |
|---|---|
| `src/lib/api.ts` | The only module that knows route names. Sandbox calls create the anonymous session first |
| `src/lib/trip-wire.ts` | Maps the API's trip document (`trip/1`) to the view model the pages render |
| `src/lib/labels.ts` | Copy and tone for every core state, outcome and reason code, plus the fixed UNKNOWN sentence |
| `src/lib/browser-proof.ts` | Loads `@intyr/verifier` on demand and verifies a manifest in the browser |
| `src/components/trip-rails.tsx` | One rail per leg across the commit boundary |
| `src/components/recovery-timeline.tsx` | Detect, act and record steps of a recovery, from the decision log |
| `src/routes/public`, `src/routes/app` | Public pages and sandbox pages |
| `src/styles/tokens.css` | Design tokens measured from the reference screens, plus contrast-corrected text colors |

## Rules the code follows

- Pages render server state only. Polling stops at terminal states and pauses while the tab is hidden. Nothing advances a state on the client.
- A 202 or an `UNKNOWN` outcome is shown as unconfirmed, never as failure or success.
- Supplier text is plain text. The page never renders it as HTML.
- Fonts are self-hosted (Inter with the optical-size axis, IBM Plex Mono with the slashed zero). There are no third-party logos or photographs.
