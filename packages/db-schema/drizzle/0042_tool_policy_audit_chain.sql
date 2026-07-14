CREATE TABLE IF NOT EXISTS "tool_policy_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence_no" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL,
  "decision" text NOT NULL,
  "enabled_toolsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "allowed_toolsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "blocked_toolsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rejected_high_blast_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enforced" boolean NOT NULL,
  "policy_hash" text NOT NULL,
  "previous_hash" text,
  "event_hash" text NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tool_policy_audit_decision_check" CHECK ("decision" IN ('allow','deny')),
  CONSTRAINT "tool_policy_audit_hash_check" CHECK (
    "policy_hash" ~ '^[a-f0-9]{64}$'
    AND "event_hash" ~ '^[a-f0-9]{64}$'
    AND ("previous_hash" IS NULL OR "previous_hash" ~ '^[a-f0-9]{64}$')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "tool_policy_audit_workspace_run_unique" ON "tool_policy_audit_events" ("workspace_id", "run_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tool_policy_audit_event_hash_unique" ON "tool_policy_audit_events" ("event_hash");
CREATE INDEX IF NOT EXISTS "tool_policy_audit_workspace_sequence_idx" ON "tool_policy_audit_events" ("workspace_id", "sequence_no");
