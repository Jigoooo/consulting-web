ALTER TABLE "consulting_insight_shadow_turns"
  ADD COLUMN IF NOT EXISTS "replay_status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "replay_lease_token" text,
  ADD COLUMN IF NOT EXISTS "replay_lease_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "replay_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "replay_error" text;
DO $$ BEGIN
  ALTER TABLE "consulting_insight_shadow_turns"
    ADD CONSTRAINT "consulting_insight_shadow_replay_status_check"
    CHECK ("replay_status" IN ('pending','processing','completed','failed','snapshot_invalid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS "consulting_insight_shadow_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "shadow_turn_id" uuid NOT NULL REFERENCES "consulting_insight_shadow_turns"("id") ON DELETE CASCADE,
  "result_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "consulting_insight_shadow_results_hash_check" CHECK ("result_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "consulting_insight_shadow_results_turn_unique" ON "consulting_insight_shadow_results" ("shadow_turn_id");
