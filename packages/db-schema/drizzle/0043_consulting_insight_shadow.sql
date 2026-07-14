CREATE TABLE IF NOT EXISTS "consulting_insight_shadow_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "thread_id" uuid NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "settlement_id" uuid NOT NULL REFERENCES "chat_turn_settlements"("id") ON DELETE CASCADE,
  "user_message_id" uuid NOT NULL REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "assistant_message_id" uuid REFERENCES "chat_messages"("id") ON DELETE SET NULL,
  "retrieval_run_id" uuid NOT NULL REFERENCES "retrieval_runs"("id") ON DELETE RESTRICT,
  "run_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "intent_decision" text NOT NULL,
  "intent_confidence" numeric NOT NULL,
  "source_message_hash" text NOT NULL,
  "retrieval_snapshot_hash" text NOT NULL,
  "policy_hash" text NOT NULL,
  "baseline_response_hash" text,
  "settled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "consulting_insight_shadow_status_check" CHECK ("status" IN ('pending','response_completed','succeeded','failed','cancelled','timed_out','failed_settlement','snapshot_invalid')),
  CONSTRAINT "consulting_insight_shadow_intent_check" CHECK ("intent_decision" = 'analysis'),
  CONSTRAINT "consulting_insight_shadow_confidence_check" CHECK ("intent_confidence" >= 0 AND "intent_confidence" <= 1),
  CONSTRAINT "consulting_insight_shadow_hash_check" CHECK (
    "source_message_hash" ~ '^[a-f0-9]{64}$'
    AND "retrieval_snapshot_hash" ~ '^[a-f0-9]{64}$'
    AND "policy_hash" ~ '^[a-f0-9]{64}$'
    AND ("baseline_response_hash" IS NULL OR "baseline_response_hash" ~ '^[a-f0-9]{64}$')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "consulting_insight_shadow_settlement_unique" ON "consulting_insight_shadow_turns" ("settlement_id");
CREATE UNIQUE INDEX IF NOT EXISTS "consulting_insight_shadow_user_message_unique" ON "consulting_insight_shadow_turns" ("user_message_id");
CREATE INDEX IF NOT EXISTS "consulting_insight_shadow_workspace_status_idx" ON "consulting_insight_shadow_turns" ("workspace_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "consulting_insight_shadow_retrieval_idx" ON "consulting_insight_shadow_turns" ("retrieval_run_id");
