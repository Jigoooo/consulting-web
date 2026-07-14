CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE artifact_review_decisions
  ADD COLUMN sequence_no bigint DEFAULT 0,
  ADD COLUMN previous_hash text,
  ADD COLUMN event_hash text NOT NULL DEFAULT '',
  ADD COLUMN actor_kind text;

UPDATE artifact_review_decisions
SET actor_kind = CASE
  WHEN decided_by_user_id IS NULL THEN 'legacy_unknown'
  ELSE 'user'
END;

ALTER TABLE artifact_review_decisions
  ALTER COLUMN actor_kind SET NOT NULL,
  ALTER COLUMN actor_kind SET DEFAULT 'user',
  ADD CONSTRAINT artifact_review_decisions_actor_ck CHECK (
    (actor_kind = 'user' AND decided_by_user_id IS NOT NULL)
    OR (actor_kind = 'legacy_unknown' AND decided_by_user_id IS NULL)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM artifact_review_decisions d
    LEFT JOIN artifacts a
      ON a.id = d.artifact_id
     AND a.workspace_id = d.workspace_id
     AND a.project_id = d.project_id
    LEFT JOIN artifact_versions av
      ON av.id = d.artifact_version_id
     AND av.workspace_id = d.workspace_id
     AND av.artifact_id = d.artifact_id
    LEFT JOIN projects p
      ON p.id = d.project_id
     AND p.workspace_id = d.workspace_id
    WHERE a.id IS NULL OR av.id IS NULL OR p.id IS NULL
  ) THEN
    RAISE EXCEPTION 'existing artifact review decision tenant tuple mismatch'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DO $$
DECLARE
  row_item record;
  chain_version uuid := NULL;
  chain_previous text := NULL;
  chain_sequence bigint := 0;
  calculated_hash text;
BEGIN
  FOR row_item IN
    SELECT * FROM artifact_review_decisions
    ORDER BY artifact_version_id, created_at, id
  LOOP
    IF chain_version IS DISTINCT FROM row_item.artifact_version_id THEN
      chain_version := row_item.artifact_version_id;
      chain_previous := NULL;
      chain_sequence := 1;
    ELSE
      chain_sequence := chain_sequence + 1;
    END IF;
    calculated_hash := encode(digest(concat_ws(E'\x1f',
      'artifact_review_decision_v2',
      chain_sequence::text,
      row_item.workspace_id::text,
      row_item.project_id::text,
      row_item.artifact_id::text,
      row_item.artifact_version_id::text,
      row_item.content_hash,
      row_item.action,
      row_item.note,
      row_item.actor_kind,
      coalesce(row_item.decided_by_user_id::text, ''),
      floor(extract(epoch FROM row_item.created_at) * 1000)::bigint::text,
      coalesce(chain_previous, '')
    ), 'sha256'), 'hex');
    UPDATE artifact_review_decisions
    SET sequence_no = chain_sequence, previous_hash = chain_previous, event_hash = calculated_hash
    WHERE id = row_item.id;
    chain_previous := calculated_hash;
  END LOOP;
END;
$$;

ALTER TABLE artifact_review_decisions
  ALTER COLUMN sequence_no SET NOT NULL,
  ALTER COLUMN event_hash DROP DEFAULT,
  ADD CONSTRAINT artifact_review_decisions_sequence_unique UNIQUE (artifact_version_id, sequence_no),
  ADD CONSTRAINT artifact_review_decisions_event_hash_unique UNIQUE (event_hash),
  ADD CONSTRAINT artifact_review_decisions_hash_format_check CHECK (
    event_hash ~ '^[a-f0-9]{64}$'
    AND (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT artifact_review_decisions_note_length_check CHECK (char_length(note) <= 1000);

CREATE INDEX artifact_review_decisions_version_sequence_idx
  ON artifact_review_decisions(artifact_version_id, sequence_no DESC);

ALTER TABLE artifact_review_decisions DROP CONSTRAINT IF EXISTS artifact_review_decisions_workspace_id_fkey;
ALTER TABLE artifact_review_decisions DROP CONSTRAINT IF EXISTS artifact_review_decisions_project_id_fkey;
ALTER TABLE artifact_review_decisions DROP CONSTRAINT IF EXISTS artifact_review_decisions_artifact_id_fkey;
ALTER TABLE artifact_review_decisions DROP CONSTRAINT IF EXISTS artifact_review_decisions_artifact_version_id_fkey;
ALTER TABLE artifact_review_decisions DROP CONSTRAINT IF EXISTS artifact_review_decisions_decided_by_user_id_fkey;

ALTER TABLE artifact_review_decisions
  ADD CONSTRAINT artifact_review_decisions_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  ADD CONSTRAINT artifact_review_decisions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  ADD CONSTRAINT artifact_review_decisions_artifact_id_fkey
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT artifact_review_decisions_artifact_version_id_fkey
    FOREIGN KEY (artifact_version_id) REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT artifact_review_decisions_decided_by_user_id_fkey
    FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_artifact_review_exact_tuple()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.actor_kind <> 'user' OR NEW.decided_by_user_id IS NULL THEN
    RAISE EXCEPTION 'new artifact review decisions require a user actor'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM artifact_versions av
    JOIN artifacts a
      ON a.id = av.artifact_id
     AND a.workspace_id = av.workspace_id
    JOIN projects p
      ON p.id = a.project_id
     AND p.workspace_id = a.workspace_id
    WHERE av.id = NEW.artifact_version_id
      AND av.artifact_id = NEW.artifact_id
      AND av.workspace_id = NEW.workspace_id
      AND a.id = NEW.artifact_id
      AND a.project_id = NEW.project_id
      AND a.workspace_id = NEW.workspace_id
      AND p.id = NEW.project_id
      AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact review decision tenant tuple mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION assign_artifact_review_hash_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  latest_hash text;
  latest_sequence_no bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.artifact_version_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM artifact_review_decisions
    WHERE artifact_version_id = NEW.artifact_version_id
      AND action = 'reject'
  ) THEN
    RAISE EXCEPTION 'artifact review reject is terminal for this version'
      USING ERRCODE = '23514';
  END IF;

  SELECT event_hash, sequence_no INTO latest_hash, latest_sequence_no
  FROM artifact_review_decisions
  WHERE artifact_version_id = NEW.artifact_version_id
  ORDER BY sequence_no DESC
  LIMIT 1;

  NEW.sequence_no := COALESCE(latest_sequence_no, 0) + 1;
  NEW.previous_hash := latest_hash;
  NEW.event_hash := encode(digest(concat_ws(E'\x1f',
    'artifact_review_decision_v2',
    NEW.sequence_no::text,
    NEW.workspace_id::text,
    NEW.project_id::text,
    NEW.artifact_id::text,
    NEW.artifact_version_id::text,
    NEW.content_hash,
    NEW.action,
    NEW.note,
    NEW.actor_kind,
    NEW.decided_by_user_id::text,
    floor(extract(epoch FROM NEW.created_at) * 1000)::bigint::text,
    coalesce(latest_hash, '')
  ), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifact_review_decisions_exact_tuple_guard
BEFORE INSERT ON artifact_review_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_review_exact_tuple();

CREATE TRIGGER artifact_review_decisions_hash_chain_guard
BEFORE INSERT ON artifact_review_decisions
FOR EACH ROW EXECUTE FUNCTION assign_artifact_review_hash_chain();

CREATE OR REPLACE FUNCTION prevent_artifact_review_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'artifact_review_decisions is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER artifact_review_decisions_no_update_delete
BEFORE UPDATE OR DELETE ON artifact_review_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_artifact_review_mutation();

CREATE TRIGGER artifact_review_decisions_no_truncate
BEFORE TRUNCATE ON artifact_review_decisions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_artifact_review_mutation();

CREATE UNIQUE INDEX trace_spans_report_workflow_parity_key_uq
  ON trace_spans (workspace_id, trace_id, name, (metadata ->> 'parityKey'))
  WHERE name = 'report_workflow.parity'
    AND metadata ? 'parityKey'
    AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION verify_artifact_review_decision_chain(p_artifact_version_id uuid)
RETURNS TABLE(valid boolean, event_count bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  row_item record;
  expected_previous text := NULL;
  expected_hash text;
  seen bigint := 0;
BEGIN
  FOR row_item IN
    SELECT * FROM artifact_review_decisions
    WHERE artifact_version_id = p_artifact_version_id
    ORDER BY sequence_no
  LOOP
    expected_hash := encode(digest(concat_ws(E'\x1f',
      'artifact_review_decision_v2',
      row_item.sequence_no::text,
      row_item.workspace_id::text,
      row_item.project_id::text,
      row_item.artifact_id::text,
      row_item.artifact_version_id::text,
      row_item.content_hash,
      row_item.action,
      row_item.note,
      row_item.actor_kind,
      coalesce(row_item.decided_by_user_id::text, ''),
      floor(extract(epoch FROM row_item.created_at) * 1000)::bigint::text,
      coalesce(expected_previous, '')
    ), 'sha256'), 'hex');
    IF row_item.previous_hash IS DISTINCT FROM expected_previous OR row_item.event_hash <> expected_hash THEN
      RETURN QUERY SELECT false, seen;
      RETURN;
    END IF;
    expected_previous := row_item.event_hash;
    seen := seen + 1;
  END LOOP;
  RETURN QUERY SELECT true, seen;
END;
$$;

COMMENT ON TABLE artifact_review_decisions IS
  'Immutable, exact-tenant, tamper-evident human review decisions. Reject is terminal per artifact version.';
