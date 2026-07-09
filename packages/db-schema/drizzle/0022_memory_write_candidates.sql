-- P0 Memory Write Guard: assistant output is review/quarantine material, not shared-brain truth.

CREATE TABLE IF NOT EXISTS memory_write_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES chat_messages(id) ON DELETE CASCADE,
  run_id text,
  policy_decision_id text NOT NULL,
  trace_id text NOT NULL,
  candidate_text text NOT NULL,
  allowed_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocked_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'quarantined',
  reason text NOT NULL DEFAULT 'assistant_output_requires_review',
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT memory_write_candidates_policy_unique UNIQUE(policy_decision_id),
  CONSTRAINT memory_write_candidates_status_chk CHECK (status IN ('quarantined', 'approved', 'rejected', 'expired')),
  CONSTRAINT memory_write_candidates_allowed_segments_array_chk CHECK (jsonb_typeof(allowed_segments) = 'array'),
  CONSTRAINT memory_write_candidates_blocked_segments_array_chk CHECK (jsonb_typeof(blocked_segments) = 'array')
);

CREATE INDEX IF NOT EXISTS memory_write_candidates_workspace_idx
  ON memory_write_candidates(workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS memory_write_candidates_thread_idx
  ON memory_write_candidates(thread_id, created_at);

CREATE INDEX IF NOT EXISTS memory_write_candidates_message_idx
  ON memory_write_candidates(assistant_message_id, created_at);

CREATE INDEX IF NOT EXISTS memory_write_candidates_trace_idx
  ON memory_write_candidates(workspace_id, trace_id);
