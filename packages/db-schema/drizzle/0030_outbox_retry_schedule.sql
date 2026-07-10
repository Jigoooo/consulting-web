-- Bound transient outbox enqueue retries and prevent hot-looping during broker outages.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_status_next_attempt_idx
  ON outbox_events(status, next_attempt_at);
