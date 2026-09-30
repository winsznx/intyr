-- Payment sessions: one row per distinct x402 payment transaction (txid is unique).
CREATE TABLE IF NOT EXISTS payment_sessions (
  id TEXT PRIMARY KEY,
  txid TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  payer TEXT NOT NULL,
  payer_class TEXT NOT NULL,
  state TEXT NOT NULL,
  first_valid INTEGER NOT NULL,
  last_valid INTEGER NOT NULL,
  settle_json TEXT,
  confirmed_round INTEGER,
  operation_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_sessions_state_idx ON payment_sessions (state, updated_at);
CREATE INDEX IF NOT EXISTS payment_sessions_payer_idx ON payment_sessions (payer);

CREATE TABLE IF NOT EXISTS payment_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_session_idx ON payment_events (session_id, seq);

-- One operation per paid action. Replaying the same payment proof returns this row.
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  result_json TEXT,
  trip_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Valid payments that reached payTo without a matching session never start work.
CREATE TABLE IF NOT EXISTS orphan_payments (
  txid TEXT PRIMARY KEY,
  payer TEXT,
  amount TEXT,
  asset TEXT,
  round INTEGER,
  observed_at TEXT NOT NULL,
  note TEXT
);
