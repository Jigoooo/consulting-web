-- Durable outbox lease ownership for crash/restart recovery.
-- Existing processing rows without an owner are made immediately reclaimable.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error text;

UPDATE outbox_events
SET lease_expires_at = now()
WHERE status = 'processing' AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_status_lease_idx
  ON outbox_events(status, lease_expires_at);
