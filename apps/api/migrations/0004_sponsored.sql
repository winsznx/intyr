-- Sandbox calls made under a cookie session with the payment sponsored by the server (TestNet only).
-- No USDC moves for these. The table exists to rate-limit them and to keep them out of payment statistics.
CREATE TABLE IF NOT EXISTS sponsored_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_session_id TEXT NOT NULL,
  route TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sponsored_calls_session_idx ON sponsored_calls (sandbox_session_id, at);
