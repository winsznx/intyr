# Registering Intyr with Electric Capital

Status: pull request https://github.com/electric-capital/open-dev-data/pull/3079 was opened on 2026-10-01 with
the file `migrations/2026-10-01T000800_add_intyr_to_algorand`. It is waiting for review. The steps below
record how it was done.

The challenge asks each project to appear in Electric Capital's open developer data under the Algorand
ecosystem. The owner opens this pull request from their own GitHub account once the repository is public.

1. Fork https://github.com/electric-capital/open-dev-data.
2. Add one file under `migrations/`, named with a colon-free ISO 8601 timestamp and a short description, for
   example `migrations/2026-09-30T230000_add_intyr_to_algorand`.
3. Put this single line in it:

   ```
   repadd Algorand https://github.com/winsznx/intyr #protocol
   ```

4. Open the pull request with the title `Add Intyr to Algorand ecosystem (x402 Global Challenge)` and a
   one-line description: "Intyr is a payment-bound commit and recovery API for AI agents, paid per action over
   x402 on Algorand."

The format comes from the repository README (checked 2026-09-30): migration files live in `migrations/` and are
named `YYYY-MM-DDThhmmss_description`, and a line reads `repadd <Ecosystem> <GitHub URL> [#tags]`. Tags are
optional. Check the README again before opening the pull request, in case the format has changed.
