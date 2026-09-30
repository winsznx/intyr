ALTER TABLE refunds ADD COLUMN network TEXT;
ALTER TABLE refunds ADD COLUMN trip_id TEXT;
ALTER TABLE refunds ADD COLUMN delivery TEXT;
ALTER TABLE refunds ADD COLUMN decision_json TEXT;
ALTER TABLE refunds ADD COLUMN last_valid INTEGER;
ALTER TABLE refunds ADD COLUMN error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS refund_once ON refunds (payment_session_id);
CREATE INDEX IF NOT EXISTS refund_state_idx ON refunds (state, network);
