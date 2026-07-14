CREATE TABLE IF NOT EXISTS artifact_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('approve', 'reject')),
  note text NOT NULL DEFAULT '',
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifact_review_version_idx
  ON artifact_review_decisions(artifact_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_review_project_idx
  ON artifact_review_decisions(workspace_id, project_id, created_at DESC);

COMMENT ON TABLE artifact_review_decisions IS
  'Append-only human artifact decisions bound to an exact content hash; never overrides verifier blockers.';
