CREATE TABLE IF NOT EXISTS telegram_reclassification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  direction text NOT NULL CHECK (direction IN ('apply', 'reverse')),
  mapping_hash text NOT NULL CHECK (mapping_hash ~ '^[0-9a-f]{64}$'),
  reverse_plan_hash text NOT NULL CHECK (reverse_plan_hash ~ '^[0-9a-f]{64}$'),
  source_identity_hash text NOT NULL CHECK (source_identity_hash ~ '^[0-9a-f]{64}$'),
  app_snapshot_hash text NOT NULL CHECK (app_snapshot_hash ~ '^[0-9a-f]{64}$'),
  route_snapshot_hash text NOT NULL CHECK (route_snapshot_hash ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count > 0),
  sync_job_id text NOT NULL CHECK (sync_job_id ~ '^[0-9a-f]{12}$'),
  quiesce_nonce uuid NOT NULL UNIQUE,
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_sha256, direction)
);

CREATE OR REPLACE FUNCTION reject_telegram_reclassification_run_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'telegram_reclassification_runs is append-only';
END;
$$;

DROP TRIGGER IF EXISTS telegram_reclassification_runs_reject_mutation
  ON telegram_reclassification_runs;
CREATE TRIGGER telegram_reclassification_runs_reject_mutation
BEFORE UPDATE OR DELETE OR TRUNCATE ON telegram_reclassification_runs
FOR EACH STATEMENT EXECUTE FUNCTION reject_telegram_reclassification_run_mutation();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON telegram_reclassification_runs FROM PUBLIC;
