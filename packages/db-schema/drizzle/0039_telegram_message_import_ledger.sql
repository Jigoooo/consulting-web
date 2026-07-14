-- Formal ledger for the Changwon Telegram → consulting-web message sync (V3-1 exact routing).
--
-- The table already exists in prod in a legacy 4-column shape
-- (source_session_id, source_message_id, web_message_id, imported_at) with historical
-- rows. This migration is therefore an idempotent ALTER that promotes it to the formal
-- V3-1 shape WITHOUT mutating or backfilling historical rows:
--   * all new provenance/routing columns stay nullable so pre-V3 rows remain unlabelled,
--   * target_web_thread_id/routing_version stay NULL because pre-V3 rows predate exact routing and
--     can only be backfilled by the approved historical-reclassification flow (V3-5/V3-7),
--   * FKs + the idempotency/reverse-map indexes are added IF NOT EXISTS.
--
-- Fresh databases get the same final shape via the ADD COLUMN IF NOT EXISTS path after the
-- CREATE TABLE IF NOT EXISTS base. Additive and re-runnable.

CREATE TABLE IF NOT EXISTS telegram_message_imports (
  source_session_id text NOT NULL,
  source_message_id bigint NOT NULL,
  web_message_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_message_imports ADD COLUMN IF NOT EXISTS telegram_chat_id text;
ALTER TABLE telegram_message_imports ADD COLUMN IF NOT EXISTS telegram_thread_id text;
ALTER TABLE telegram_message_imports ADD COLUMN IF NOT EXISTS target_web_thread_id uuid;
ALTER TABLE telegram_message_imports ADD COLUMN IF NOT EXISTS routing_version text;

-- Deliberately do not rewrite legacy source_message_id or backfill any new column. Fresh tables
-- use bigint; an existing integer column remains valid for its historical values and new inserts.

-- FK guards (added only when the constraint is absent so the migration stays re-runnable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_message_imports_web_message_fk'
  ) THEN
    ALTER TABLE telegram_message_imports
      ADD CONSTRAINT telegram_message_imports_web_message_fk
      FOREIGN KEY (web_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_message_imports_target_thread_fk'
  ) THEN
    ALTER TABLE telegram_message_imports
      ADD CONSTRAINT telegram_message_imports_target_thread_fk
      FOREIGN KEY (target_web_thread_id) REFERENCES threads(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS telegram_message_imports_source_unique
  ON telegram_message_imports (source_session_id, source_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_message_imports_web_message_unique
  ON telegram_message_imports (web_message_id);

CREATE INDEX IF NOT EXISTS telegram_message_imports_target_thread_idx
  ON telegram_message_imports (target_web_thread_id);

CREATE INDEX IF NOT EXISTS telegram_message_imports_chat_thread_idx
  ON telegram_message_imports (telegram_chat_id, telegram_thread_id);
