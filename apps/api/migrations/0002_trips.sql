-- Anonymous sandbox sessions (cookie). Data expires with the session.
CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- A trip is owned by a payer wallet (paid API) or a sandbox session (UI). The document holds the typed trip.
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  currency TEXT,
  total_minor INTEGER,
  readiness INTEGER,
  doc_json TEXT NOT NULL,
  operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_owner_idx ON trips (owner, created_at DESC);

-- Signed documents (plans, commit manifests, transaction manifests) addressable by id.
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY,
  trip_id TEXT,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  network TEXT NOT NULL,
  signed_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manifests_trip_idx ON manifests (trip_id, created_at);

-- Every gate decision, hash chained per subject.
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  trip_id TEXT,
  gate TEXT NOT NULL,
  outcome TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_trip_idx ON decisions (trip_id, created_at);

-- Write-ahead attempt log. A supplier commit is only ever called after its row exists, and a row in
-- STARTED or RESPONDED is never committed again: it goes to reconciliation.
CREATE TABLE IF NOT EXISTS commit_attempts (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  action TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  idempotency_ref TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS commit_attempt_once ON commit_attempts (trip_id, component_id) WHERE action = 'COMMIT';
CREATE UNIQUE INDEX IF NOT EXISTS cancel_attempt_once ON commit_attempts (trip_id, component_id, attempt_no) WHERE action <> 'COMMIT';

CREATE TABLE IF NOT EXISTS anchors (
  manifest_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  mode TEXT NOT NULL,
  txid TEXT,
  state TEXT NOT NULL,
  round INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  amount TEXT NOT NULL,
  reason TEXT NOT NULL,
  txid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
