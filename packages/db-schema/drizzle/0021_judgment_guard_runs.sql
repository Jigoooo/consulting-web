-- Judgment Guard ledger for cross-project consulting reasoning safeguards.
-- Applying this migration is a DB mutation gate; code can be reviewed before live apply.

CREATE TABLE IF NOT EXISTS judgment_guard_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES chat_messages(id) ON DELETE CASCADE,
  run_kind text NOT NULL DEFAULT 'judgment_guard_v1',
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'skipped',
  query_hash text NOT NULL,
  issue_summary text NOT NULL DEFAULT 'none',
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_time_iso text NOT NULL,
  user_correction_detected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT judgment_guard_runs_status_chk CHECK (status IN ('skipped', 'passed', 'warnings', 'blocked')),
  CONSTRAINT judgment_guard_runs_kind_chk CHECK (run_kind IN ('judgment_guard_v1')),
  CONSTRAINT judgment_guard_runs_issues_array_chk CHECK (jsonb_typeof(issues) = 'array'),
  CONSTRAINT judgment_guard_runs_prompt_rules_array_chk CHECK (jsonb_typeof(prompt_rules) = 'array')
);

-- Allowed issue code vocabulary v1:
-- source_intake_parse_failure
-- applicability_map_required
-- decision_gate_order_required
-- latest_authority_required
-- comparator_consistency_required
-- counterargument_required
-- user_correction_pattern
-- overclaim_strength_risk

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS judgment_guard_runs_workspace_idx
  ON judgment_guard_runs(workspace_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS judgment_guard_runs_thread_idx
  ON judgment_guard_runs(thread_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS judgment_guard_runs_message_idx
  ON judgment_guard_runs(assistant_message_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS judgment_guard_runs_status_idx
  ON judgment_guard_runs(workspace_id, status, created_at);
