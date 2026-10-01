# Changes after submission

The entry was submitted on 2026-09-30, US Eastern time. [SUBMISSION.md](SUBMISSION.md) keeps the answers as
submitted. This file logs every deploy since then, oldest first. Before the first entry the host ran `77f22d7`.

| Date | Deployed commit | What changed | Evidence |
|---|---|---|---|
| 2026-10-01 | `6f6439d` | The last audit batch, `eedc0c2` to `5ca9e41`: `allow_replacement` defaults to false, reconcilers are scoped to their network, request schemas are published in the Bazaar extension, the example prepare is priced in EUR, and the web fixes for the quickstart sample, the evidence index, the campaign quote and the plan view on `/verify`. `6f6439d` itself only ignores the local video folder | `GET /version` reported `6f6439d`. check-402 passed on Mainnet and TestNet, and RUN-001 verified `PROOF_VERIFIED` |
| 2026-10-01 | `bd42610` | The owner's brand kit on the web, `ca6fe17` to `bd42610`: the header lockup, the favicon set, manifest icons, a redesigned link-preview card at `/og.png?v=2` with its source in `apps/web/og/`, and real `/favicon.ico`, `/robots.txt` and `/site.webmanifest` files, which were answered with the app's HTML before. The API code is unchanged from `6f6439d` | `GET /version` reports `bd42610`. The new files are served as `image/vnd.microsoft.icon`, `text/plain` and `application/manifest+json`. check-402 passes on Mainnet and TestNet, and RUN-001 still verifies `PROOF_VERIFIED` |

Commits that change only docs, such as `950c76e`, don't change the running system and aren't listed.
