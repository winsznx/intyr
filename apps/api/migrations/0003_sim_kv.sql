-- Key value store behind the seeded supplier simulator. Only sandbox runs write here.
CREATE TABLE IF NOT EXISTS sim_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
