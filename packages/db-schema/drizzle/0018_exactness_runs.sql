-- Exactness Gate ledger for tool-backed calculation/source/DB/date checks.
-- Applying this migration is a DB mutation gate; code can be reviewed before live apply.

CREATE TABLE IF NOT EXISTS exactness_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES chat_messages(id) ON DELETE CASCADE,
  run_kind text NOT NULL DEFAULT 'exactness_gate_v1',
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  query_hash text NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL DEFAULT '',
  answer_instruction text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT exactness_runs_status_chk CHECK (status IN ('skipped', 'passed', 'blocked')),
  CONSTRAINT exactness_runs_kind_chk CHECK (run_kind IN ('exactness_gate_v1'))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS exactness_runs_workspace_idx
  ON exactness_runs(workspace_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS exactness_runs_thread_idx
  ON exactness_runs(thread_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS exactness_runs_message_idx
  ON exactness_runs(assistant_message_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS exactness_runs_status_idx
  ON exactness_runs(workspace_id, status, created_at);
