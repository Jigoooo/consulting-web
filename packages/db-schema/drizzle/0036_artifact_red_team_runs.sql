CREATE TABLE IF NOT EXISTS artifact_red_team_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  mode text NOT NULL,
  policy_version text NOT NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  lease_token text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  recovery_count integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_red_team_jobs_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artifact_red_team_jobs_mode_check CHECK (mode IN ('shadow', 'warning')),
  CONSTRAINT artifact_red_team_jobs_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT artifact_red_team_jobs_counter_check CHECK (attempt_count >= 0 AND recovery_count >= 0),
  CONSTRAINT artifact_red_team_jobs_lease_check CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_red_team_jobs_active_unique
  ON artifact_red_team_jobs (workspace_id, artifact_version_id, content_hash, policy_version)
  WHERE status IN ('pending', 'processing', 'completed');
CREATE INDEX IF NOT EXISTS artifact_red_team_jobs_scope_idx
  ON artifact_red_team_jobs (workspace_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_red_team_jobs_status_lease_idx
  ON artifact_red_team_jobs (status, lease_expires_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS artifact_red_team_jobs_version_hash_idx
  ON artifact_red_team_jobs (artifact_version_id, content_hash, sequence_no DESC);

CREATE TABLE IF NOT EXISTS artifact_red_team_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES artifact_red_team_jobs(id) ON DELETE RESTRICT,
  sequence_no bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  content_hash text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  policy_version text NOT NULL,
  personas jsonb NOT NULL DEFAULT '[]'::jsonb,
  attacks jsonb NOT NULL DEFAULT '[]'::jsonb,
  defenses jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict text NOT NULL,
  reviewer_run_id text,
  error_message text,
  reviewed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_red_team_runs_job_unique UNIQUE (job_id),
  CONSTRAINT artifact_red_team_runs_sequence_unique UNIQUE (sequence_no),
  CONSTRAINT artifact_red_team_runs_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artifact_red_team_runs_mode_check CHECK (mode IN ('shadow', 'warning')),
  CONSTRAINT artifact_red_team_runs_status_check CHECK (status IN ('completed', 'failed')),
  CONSTRAINT artifact_red_team_runs_verdict_check CHECK (verdict IN ('PASS', 'PASS_WITH_WARNINGS', 'BLOCKED')),
  CONSTRAINT artifact_red_team_runs_outcome_check CHECK (
    (status = 'completed' AND reviewer_run_id IS NOT NULL AND error_message IS NULL)
    OR (status = 'failed' AND verdict = 'BLOCKED' AND error_message IS NOT NULL)
  ),
  CONSTRAINT artifact_red_team_runs_payload_check CHECK (
    jsonb_typeof(personas) = 'array'
    AND jsonb_array_length(personas) = 3
    AND personas @> '["감사원", "의회", "노조"]'::jsonb
    AND personas <@ '["감사원", "의회", "노조"]'::jsonb
    AND jsonb_typeof(attacks) = 'array'
    AND jsonb_typeof(defenses) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS artifact_red_team_runs_scope_idx
  ON artifact_red_team_runs (workspace_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_red_team_runs_version_hash_idx
  ON artifact_red_team_runs (artifact_version_id, content_hash, sequence_no);

CREATE OR REPLACE FUNCTION enforce_artifact_red_team_job_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM artifacts a
    JOIN artifact_versions v ON v.artifact_id = a.id
    WHERE a.id = NEW.artifact_id
      AND a.workspace_id = NEW.workspace_id
      AND a.project_id = NEW.project_id
      AND v.id = NEW.artifact_version_id
      AND v.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact red-team job scope mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS artifact_red_team_jobs_scope_guard ON artifact_red_team_jobs;
CREATE TRIGGER artifact_red_team_jobs_scope_guard
BEFORE INSERT ON artifact_red_team_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_red_team_job_scope();

CREATE OR REPLACE FUNCTION enforce_artifact_red_team_run_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM artifacts a
    JOIN artifact_versions v ON v.artifact_id = a.id
    WHERE a.id = NEW.artifact_id
      AND a.workspace_id = NEW.workspace_id
      AND a.project_id = NEW.project_id
      AND v.id = NEW.artifact_version_id
      AND v.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact red-team run scope mismatch';
  END IF;
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_red_team_jobs j
    WHERE j.id = NEW.job_id
      AND j.workspace_id = NEW.workspace_id
      AND j.project_id = NEW.project_id
      AND j.artifact_id = NEW.artifact_id
      AND j.artifact_version_id = NEW.artifact_version_id
      AND j.content_hash = NEW.content_hash
      AND j.policy_version = NEW.policy_version
      AND j.mode = NEW.mode
      AND j.status = NEW.status
  ) THEN
    RAISE EXCEPTION 'artifact red-team run job mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS artifact_red_team_runs_scope_guard ON artifact_red_team_runs;
CREATE TRIGGER artifact_red_team_runs_scope_guard
BEFORE INSERT ON artifact_red_team_runs
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_red_team_run_scope();

CREATE OR REPLACE FUNCTION reject_artifact_red_team_run_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'artifact red-team runs are append-only';
END;
$$;

DROP TRIGGER IF EXISTS artifact_red_team_runs_append_only_guard ON artifact_red_team_runs;
CREATE TRIGGER artifact_red_team_runs_append_only_guard
BEFORE UPDATE OR DELETE ON artifact_red_team_runs
FOR EACH ROW EXECUTE FUNCTION reject_artifact_red_team_run_mutation();
