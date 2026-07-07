-- Link claim-verification verdicts back to the exact assistant message.
-- This powers inline message badges and keeps older 0014 installs upgrade-safe.

ALTER TABLE claim_verification_verdicts
  ADD COLUMN IF NOT EXISTS assistant_message_id uuid REFERENCES chat_messages(id) ON DELETE CASCADE;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_verdicts_message_idx
  ON claim_verification_verdicts(assistant_message_id, created_at);
