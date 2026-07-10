-- Final-export verification ledger bound to immutable artifact version content.

CREATE TABLE IF NOT EXISTS artifact_version_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  source_thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  status text NOT NULL,
  exactness jsonb NOT NULL,
  verdicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  gate jsonb NOT NULL,
  verifier text NOT NULL,
  evidence_count integer NOT NULL DEFAULT 0,
  verified_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT artifact_verifications_status_check CHECK (status IN ('passed', 'blocked')),
  CONSTRAINT artifact_verifications_gate_status_check CHECK (COALESCE((
    jsonb_typeof(gate) = 'object'
    AND jsonb_typeof(gate->'blockers') = 'array'
    AND jsonb_typeof(gate->'warnings') = 'array'
    AND (
      (
        status = 'passed'
        AND gate->>'decision' = 'PASS'
        AND jsonb_array_length(gate->'blockers') = 0
        AND jsonb_array_length(gate->'warnings') = 0
      )
      OR (
        status = 'blocked'
        AND gate->>'decision' IN ('BLOCKED', 'PASS_WITH_WARNINGS')
      )
    )
  ), false)),
  CONSTRAINT artifact_verifications_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT artifact_verifications_evidence_count_check CHECK (evidence_count >= 0)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS artifact_verifications_scope_idx
  ON artifact_version_verifications(workspace_id, project_id, created_at);

CREATE INDEX IF NOT EXISTS artifact_verifications_artifact_idx
  ON artifact_version_verifications(artifact_id, artifact_version_id, sequence_no DESC);

CREATE INDEX IF NOT EXISTS artifact_verifications_version_hash_idx
  ON artifact_version_verifications(artifact_version_id, content_hash, sequence_no DESC);
