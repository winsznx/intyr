-- SQLite and D1 accept NULL in a TEXT PRIMARY KEY unless it is declared NOT NULL, and these keys were declared without it.
-- A NULL key is unreachable by lookup and is never unique, so these triggers refuse it on insert and update.

CREATE TRIGGER IF NOT EXISTS payment_sessions_id_not_null_insert BEFORE INSERT ON payment_sessions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'payment_sessions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS payment_sessions_id_not_null_update BEFORE UPDATE OF id ON payment_sessions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'payment_sessions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS operations_id_not_null_insert BEFORE INSERT ON operations WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'operations.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS operations_id_not_null_update BEFORE UPDATE OF id ON operations WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'operations.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS orphan_payments_txid_not_null_insert BEFORE INSERT ON orphan_payments WHEN NEW.txid IS NULL BEGIN SELECT RAISE(ABORT, 'orphan_payments.txid must not be null'); END;
CREATE TRIGGER IF NOT EXISTS orphan_payments_txid_not_null_update BEFORE UPDATE OF txid ON orphan_payments WHEN NEW.txid IS NULL BEGIN SELECT RAISE(ABORT, 'orphan_payments.txid must not be null'); END;
CREATE TRIGGER IF NOT EXISTS sandbox_sessions_id_not_null_insert BEFORE INSERT ON sandbox_sessions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'sandbox_sessions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS sandbox_sessions_id_not_null_update BEFORE UPDATE OF id ON sandbox_sessions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'sandbox_sessions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS trips_id_not_null_insert BEFORE INSERT ON trips WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'trips.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS trips_id_not_null_update BEFORE UPDATE OF id ON trips WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'trips.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS manifests_id_not_null_insert BEFORE INSERT ON manifests WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'manifests.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS manifests_id_not_null_update BEFORE UPDATE OF id ON manifests WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'manifests.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS decisions_id_not_null_insert BEFORE INSERT ON decisions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'decisions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS decisions_id_not_null_update BEFORE UPDATE OF id ON decisions WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'decisions.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS commit_attempts_id_not_null_insert BEFORE INSERT ON commit_attempts WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'commit_attempts.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS commit_attempts_id_not_null_update BEFORE UPDATE OF id ON commit_attempts WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'commit_attempts.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS anchors_manifest_id_not_null_insert BEFORE INSERT ON anchors WHEN NEW.manifest_id IS NULL BEGIN SELECT RAISE(ABORT, 'anchors.manifest_id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS anchors_manifest_id_not_null_update BEFORE UPDATE OF manifest_id ON anchors WHEN NEW.manifest_id IS NULL BEGIN SELECT RAISE(ABORT, 'anchors.manifest_id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS approvals_id_not_null_insert BEFORE INSERT ON approvals WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'approvals.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS approvals_id_not_null_update BEFORE UPDATE OF id ON approvals WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'approvals.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS refunds_id_not_null_insert BEFORE INSERT ON refunds WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'refunds.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS refunds_id_not_null_update BEFORE UPDATE OF id ON refunds WHEN NEW.id IS NULL BEGIN SELECT RAISE(ABORT, 'refunds.id must not be null'); END;
CREATE TRIGGER IF NOT EXISTS sim_kv_k_not_null_insert BEFORE INSERT ON sim_kv WHEN NEW.k IS NULL BEGIN SELECT RAISE(ABORT, 'sim_kv.k must not be null'); END;
CREATE TRIGGER IF NOT EXISTS sim_kv_k_not_null_update BEFORE UPDATE OF k ON sim_kv WHEN NEW.k IS NULL BEGIN SELECT RAISE(ABORT, 'sim_kv.k must not be null'); END;
