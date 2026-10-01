-- A hash of the address a sandbox session was created from, so one address cannot mint sessions without limit.
-- The address itself is never stored.
ALTER TABLE sandbox_sessions ADD COLUMN client_hash TEXT;
CREATE INDEX IF NOT EXISTS sandbox_sessions_client_idx ON sandbox_sessions (client_hash, created_at);
