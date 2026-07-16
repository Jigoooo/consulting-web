CREATE TABLE IF NOT EXISTS "decision_analytics_source_locks" (
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid,
  CONSTRAINT "decision_analytics_source_locks_kind_check"
    CHECK ("source_kind" IN ('scorecard', 'artifact_version')),
  CONSTRAINT "decision_analytics_source_locks_pk" PRIMARY KEY ("source_kind", "source_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_analytics_source_locks_run_idx"
  ON "decision_analytics_source_locks" ("run_id") WHERE "run_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "decision_analytics_source_locks" ("source_kind", "source_id", "workspace_id", "run_id")
SELECT DISTINCT ON (r."scorecard_id")
  'scorecard', r."scorecard_id", r."workspace_id", r."id"
FROM "decision_analytics_runs" r
ORDER BY r."scorecard_id", r."created_at", r."id"
ON CONFLICT ("source_kind", "source_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "decision_analytics_source_locks" ("source_kind", "source_id", "workspace_id", "run_id")
SELECT DISTINCT ON (r."artifact_version_id")
  'artifact_version', r."artifact_version_id", r."workspace_id", r."id"
FROM "decision_analytics_runs" r
WHERE r."artifact_version_id" IS NOT NULL
ORDER BY r."artifact_version_id", r."created_at", r."id"
ON CONFLICT ("source_kind", "source_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lock_decision_analytics_run_sources"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "decision_analytics_source_locks" (
    "source_kind", "source_id", "workspace_id", "run_id"
  ) VALUES ('scorecard', NEW."scorecard_id", NEW."workspace_id", NEW."id")
  ON CONFLICT ("source_kind", "source_id") DO NOTHING;

  IF NEW."artifact_version_id" IS NOT NULL THEN
    INSERT INTO "decision_analytics_source_locks" (
      "source_kind", "source_id", "workspace_id", "run_id"
    ) VALUES ('artifact_version', NEW."artifact_version_id", NEW."workspace_id", NEW."id")
    ON CONFLICT ("source_kind", "source_id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_analytics_runs_a_lock_sources" ON "decision_analytics_runs";
CREATE TRIGGER "decision_analytics_runs_a_lock_sources"
BEFORE INSERT ON "decision_analytics_runs"
FOR EACH ROW EXECUTE FUNCTION "lock_decision_analytics_run_sources"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "decision_analytics_source_is_locked"(
  checked_kind text,
  checked_id uuid,
  checked_workspace_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO "decision_analytics_source_locks" (
    "source_kind", "source_id", "workspace_id", "run_id"
  ) VALUES (checked_kind, checked_id, checked_workspace_id, NULL)
  ON CONFLICT ("source_kind", "source_id") DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 1 THEN
    DELETE FROM "decision_analytics_source_locks"
    WHERE "source_kind" = checked_kind
      AND "source_id" = checked_id
      AND "run_id" IS NULL;
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_decision_analytics_source_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  source_workspace_id uuid;
  has_bound_run boolean := false;
  first_scorecard_id uuid;
  second_scorecard_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'decision_scorecard_items' AND TG_OP = 'INSERT' THEN
    has_bound_run := "decision_analytics_source_is_locked"(
      'scorecard', NEW."scorecard_id", NEW."workspace_id"
    );
    IF NOT has_bound_run THEN
      SELECT EXISTS (
        SELECT 1 FROM "decision_analytics_runs" r
        WHERE r."scorecard_id" = NEW."scorecard_id"
      ) INTO has_bound_run;
    END IF;
  ELSE
    source_workspace_id := OLD."workspace_id";
    IF TG_OP = 'DELETE' AND NOT EXISTS (
      SELECT 1 FROM "workspaces" w WHERE w."id" = source_workspace_id
    ) THEN
      RETURN OLD;
    END IF;

    IF TG_TABLE_NAME = 'decision_scorecards' THEN
      has_bound_run := "decision_analytics_source_is_locked"(
        'scorecard', OLD."id", OLD."workspace_id"
      );
      IF NOT has_bound_run THEN
        SELECT EXISTS (
          SELECT 1 FROM "decision_analytics_runs" r
          WHERE r."scorecard_id" = OLD."id"
        ) INTO has_bound_run;
      END IF;
    ELSIF TG_TABLE_NAME = 'decision_scorecard_items' THEN
      first_scorecard_id := OLD."scorecard_id";
      second_scorecard_id := CASE WHEN TG_OP = 'UPDATE' THEN NEW."scorecard_id" ELSE OLD."scorecard_id" END;
      IF second_scorecard_id < first_scorecard_id THEN
        first_scorecard_id := second_scorecard_id;
        second_scorecard_id := OLD."scorecard_id";
      END IF;

      has_bound_run := "decision_analytics_source_is_locked"(
        'scorecard', first_scorecard_id, OLD."workspace_id"
      );
      IF NOT has_bound_run AND second_scorecard_id <> first_scorecard_id THEN
        has_bound_run := "decision_analytics_source_is_locked"(
          'scorecard', second_scorecard_id, NEW."workspace_id"
        );
      END IF;
      IF NOT has_bound_run THEN
        SELECT EXISTS (
          SELECT 1 FROM "decision_analytics_runs" r
          WHERE r."scorecard_id" = OLD."scorecard_id"
        ) INTO has_bound_run;
      END IF;
      IF TG_OP = 'UPDATE' AND NOT has_bound_run THEN
        SELECT EXISTS (
          SELECT 1 FROM "decision_analytics_runs" r
          WHERE r."scorecard_id" = NEW."scorecard_id"
        ) INTO has_bound_run;
      END IF;
    ELSIF TG_TABLE_NAME = 'artifact_versions' THEN
      has_bound_run := "decision_analytics_source_is_locked"(
        'artifact_version', OLD."id", OLD."workspace_id"
      );
      IF NOT has_bound_run THEN
        SELECT EXISTS (
          SELECT 1 FROM "decision_analytics_runs" r
          WHERE r."artifact_version_id" = OLD."id"
        ) INTO has_bound_run;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported decision analytics source table: %', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF has_bound_run THEN
    RAISE EXCEPTION 'decision analytics source snapshot is immutable after analytics run'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_scorecards_analytics_snapshot_immutable" ON "decision_scorecards";
CREATE TRIGGER "decision_scorecards_analytics_snapshot_immutable"
BEFORE UPDATE OR DELETE ON "decision_scorecards"
FOR EACH ROW EXECUTE FUNCTION "prevent_decision_analytics_source_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_scorecard_items_analytics_snapshot_immutable" ON "decision_scorecard_items";
CREATE TRIGGER "decision_scorecard_items_analytics_snapshot_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "decision_scorecard_items"
FOR EACH ROW EXECUTE FUNCTION "prevent_decision_analytics_source_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "artifact_versions_analytics_snapshot_immutable" ON "artifact_versions";
CREATE TRIGGER "artifact_versions_analytics_snapshot_immutable"
BEFORE UPDATE OR DELETE ON "artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "prevent_decision_analytics_source_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_decision_scorecard_items_truncate"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'decision analytics source snapshot is immutable after analytics run'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_scorecard_items_analytics_snapshot_no_truncate" ON "decision_scorecard_items";
CREATE TRIGGER "decision_scorecard_items_analytics_snapshot_no_truncate"
BEFORE TRUNCATE ON "decision_scorecard_items"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_decision_scorecard_items_truncate"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_deletion_tombstones" (
  "workspace_id_hash" text PRIMARY KEY,
  "is_permanent" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_deletion_tombstones_hash_check"
    CHECK ("workspace_id_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_workspace_id_resurrection"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  checked_hash text;
  inserted_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_hash := encode(digest(OLD."id"::text, 'sha256'), 'hex');
    INSERT INTO "workspace_deletion_tombstones" ("workspace_id_hash", "is_permanent")
    VALUES (checked_hash, true)
    ON CONFLICT ("workspace_id_hash") DO UPDATE
      SET "is_permanent" = true;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" THEN
      RAISE EXCEPTION 'workspace id is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  checked_hash := encode(digest(NEW."id"::text, 'sha256'), 'hex');
  INSERT INTO "workspace_deletion_tombstones" ("workspace_id_hash", "is_permanent")
  VALUES (checked_hash, false)
  ON CONFLICT ("workspace_id_hash") DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN
    RAISE EXCEPTION 'workspace id cannot be reused after hard deletion'
      USING ERRCODE = '55000';
  END IF;
  DELETE FROM "workspace_deletion_tombstones"
  WHERE "workspace_id_hash" = checked_hash
    AND "is_permanent" = false;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspaces_a_prevent_id_resurrection" ON "workspaces";
CREATE TRIGGER "workspaces_a_prevent_id_resurrection"
BEFORE INSERT OR UPDATE ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "guard_workspace_id_resurrection"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspaces_z_record_deletion_tombstone" ON "workspaces";
CREATE TRIGGER "workspaces_z_record_deletion_tombstone"
BEFORE DELETE ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "guard_workspace_id_resurrection"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_workspace_deletion_tombstone_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."is_permanent" = false THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD."is_permanent" = false
    AND NEW."is_permanent" = true
    AND NEW."workspace_id_hash" = OLD."workspace_id_hash"
    AND NEW."deleted_at" = OLD."deleted_at"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workspace deletion tombstones are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_deletion_tombstones_no_update_delete" ON "workspace_deletion_tombstones";
CREATE TRIGGER "workspace_deletion_tombstones_no_update_delete"
BEFORE UPDATE OR DELETE ON "workspace_deletion_tombstones"
FOR EACH ROW EXECUTE FUNCTION "prevent_workspace_deletion_tombstone_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_deletion_tombstones_no_truncate" ON "workspace_deletion_tombstones";
CREATE TRIGGER "workspace_deletion_tombstones_no_truncate"
BEFORE TRUNCATE ON "workspace_deletion_tombstones"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_workspace_deletion_tombstone_mutation"();
