CREATE TABLE IF NOT EXISTS chat_turn_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  assistant_message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_prompt text NOT NULL,
  user_text text NOT NULL,
  assistant_text text NOT NULL,
  run_id text,
  finish_state text NOT NULL,
  tool_uses jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  evidence_status text NOT NULL DEFAULT 'pending',
  verification_status text NOT NULL DEFAULT 'pending',
  brain_status text NOT NULL DEFAULT 'pending',
  notification_status text NOT NULL DEFAULT 'pending',
  verified_contradictions jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_token text,
  lease_expires_at timestamptz,
  verification_lease_token text,
  verification_lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  recovery_count integer NOT NULL DEFAULT 0,
  last_error text,
  step_errors jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_turn_settlements_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'dead')),
  CONSTRAINT chat_turn_settlements_evidence_status_check
    CHECK (evidence_status IN ('pending', 'completed', 'skipped')),
  CONSTRAINT chat_turn_settlements_verification_status_check
    CHECK (verification_status IN ('pending', 'processing', 'completed', 'skipped')),
  CONSTRAINT chat_turn_settlements_brain_status_check
    CHECK (brain_status IN ('pending', 'completed', 'skipped')),
  CONSTRAINT chat_turn_settlements_notification_status_check
    CHECK (notification_status IN ('pending', 'completed', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_turn_settlements_user_message_unique
  ON chat_turn_settlements (user_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_turn_settlements_assistant_message_unique
  ON chat_turn_settlements (assistant_message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_turn_settlements_workspace_status_idx
  ON chat_turn_settlements (workspace_id, status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_turn_settlements_status_lease_idx
  ON chat_turn_settlements (status, lease_expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_turn_settlements_thread_idx
  ON chat_turn_settlements (thread_id, created_at);
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedup_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notifications_workspace_user_dedup_unique
  ON notifications (workspace_id, user_id, dedup_key);
