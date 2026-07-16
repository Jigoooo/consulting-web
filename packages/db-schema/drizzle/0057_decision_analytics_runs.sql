CREATE TABLE IF NOT EXISTS "decision_analytics_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence_no" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "scorecard_id" uuid NOT NULL,
  "artifact_version_id" uuid,
  "artifact_content_hash" text,
  "method_version" text NOT NULL,
  "input_hash" text NOT NULL,
  "input_snapshot" jsonb NOT NULL,
  "sensitivity" jsonb NOT NULL,
  "impact" jsonb,
  "actor_kind" text NOT NULL,
  "actor_user_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "decision_analytics_runs_sequence_unique" UNIQUE("sequence_no"),
  CONSTRAINT "decision_analytics_runs_input_unique" UNIQUE NULLS NOT DISTINCT(
    "workspace_id", "scorecard_id", "input_hash", "actor_kind", "actor_user_id"
  ),
  CONSTRAINT "decision_analytics_runs_method_check" CHECK ("method_version" = 'decision_analytics_v2'),
  CONSTRAINT "decision_analytics_runs_input_hash_check" CHECK ("input_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "decision_analytics_runs_artifact_pair_check" CHECK (
    ("artifact_version_id" IS NULL AND "artifact_content_hash" IS NULL)
    OR ("artifact_version_id" IS NOT NULL AND "artifact_content_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "decision_analytics_runs_actor_pair_check" CHECK (
    ("actor_kind" = 'system' AND "actor_user_id" IS NULL)
    OR ("actor_kind" = 'user' AND "actor_user_id" IS NOT NULL)
  ),
  CONSTRAINT "decision_analytics_runs_input_object_check" CHECK (jsonb_typeof("input_snapshot") = 'object'),
  CONSTRAINT "decision_analytics_runs_sensitivity_object_check" CHECK (jsonb_typeof("sensitivity") = 'object'),
  CONSTRAINT "decision_analytics_runs_impact_object_check" CHECK ("impact" IS NULL OR jsonb_typeof("impact") = 'object'),
  CONSTRAINT "decision_analytics_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "decision_analytics_runs_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE NO ACTION,
  CONSTRAINT "decision_analytics_runs_scorecard_fk" FOREIGN KEY ("scorecard_id") REFERENCES "decision_scorecards"("id") ON DELETE NO ACTION,
  CONSTRAINT "decision_analytics_runs_artifact_version_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "artifact_versions"("id") ON DELETE NO ACTION,
  CONSTRAINT "decision_analytics_runs_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_analytics_runs_thread_idx"
  ON "decision_analytics_runs" ("thread_id", "sequence_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_analytics_runs_artifact_version_idx"
  ON "decision_analytics_runs" ("artifact_version_id", "sequence_no");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_decision_analytics_run_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "decision_scorecards" sc
    JOIN "threads" th ON th."id" = sc."thread_id"
    JOIN "topics" tp ON tp."id" = th."topic_id"
    JOIN "channels" ch ON ch."id" = tp."channel_id"
    JOIN "projects" p ON p."id" = ch."project_id"
    WHERE sc."id" = NEW."scorecard_id"
      AND sc."workspace_id" = NEW."workspace_id"
      AND sc."thread_id" = NEW."thread_id"
      AND th."workspace_id" = NEW."workspace_id"
      AND tp."workspace_id" = NEW."workspace_id"
      AND ch."workspace_id" = NEW."workspace_id"
      AND p."workspace_id" = NEW."workspace_id"
      AND sc."deleted_at" IS NULL
      AND th."deleted_at" IS NULL
      AND tp."deleted_at" IS NULL
      AND ch."deleted_at" IS NULL
      AND p."deleted_at" IS NULL
      AND th."status" = 'active'
      AND tp."status" = 'active'
      AND ch."status" = 'active'
      AND p."status" = 'active'
  ) THEN
    RAISE EXCEPTION 'decision analytics run scope does not match an active scorecard and thread'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."artifact_version_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "artifact_versions" av
    JOIN "artifacts" a ON a."id" = av."artifact_id"
    JOIN "chat_messages" cm ON cm."id" = av."source_message_id"
    JOIN "decision_scorecards" sc ON sc."id" = NEW."scorecard_id"
    WHERE av."id" = NEW."artifact_version_id"
      AND av."workspace_id" = NEW."workspace_id"
      AND av."source_thread_id" = NEW."thread_id"
      AND a."workspace_id" = NEW."workspace_id"
      AND a."deleted_at" IS NULL
      AND cm."workspace_id" = NEW."workspace_id"
      AND cm."thread_id" = NEW."thread_id"
      AND cm."role" = 'assistant'
      AND cm."finish_state" = 'complete'
      AND cm."deleted_at" IS NULL
      AND cm."run_id" IS NOT NULL
      AND sc."workspace_id" = NEW."workspace_id"
      AND sc."thread_id" = NEW."thread_id"
      AND sc."deleted_at" IS NULL
      AND sc."score_summary" ->> 'runId' = cm."run_id"
      AND encode(digest(
        CASE
          WHEN av."governing_message" IS NULL AND av."so_what" IS NULL THEN av."content"
          ELSE '["artifact-version-structure-v1",'
            || to_json(av."content")::text || ','
            || COALESCE(to_json(av."governing_message")::text, 'null') || ','
            || COALESCE(to_json(av."so_what")::text, 'null') || ']'
        END,
        'sha256'
      ), 'hex') = NEW."artifact_content_hash"
  ) THEN
    RAISE EXCEPTION 'decision analytics artifact binding does not match version scope or content hash'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."actor_kind" = 'user' AND NOT EXISTS (
    SELECT 1
    FROM "memberships" m
    JOIN "users" u ON u."id" = m."user_id"
    WHERE m."workspace_id" = NEW."workspace_id"
      AND m."user_id" = NEW."actor_user_id"
      AND u."status" = 'active'
      AND u."deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'decision analytics user actor is not an active workspace member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_analytics_runs_validate_scope" ON "decision_analytics_runs";
CREATE TRIGGER "decision_analytics_runs_validate_scope"
BEFORE INSERT ON "decision_analytics_runs"
FOR EACH ROW EXECUTE FUNCTION "validate_decision_analytics_run_scope"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_decision_analytics_run_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM "workspaces" w WHERE w."id" = OLD."workspace_id"
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'decision_analytics_runs is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_analytics_runs_no_update_delete" ON "decision_analytics_runs";
CREATE TRIGGER "decision_analytics_runs_no_update_delete"
BEFORE UPDATE OR DELETE ON "decision_analytics_runs"
FOR EACH ROW EXECUTE FUNCTION "prevent_decision_analytics_run_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_analytics_runs_no_truncate" ON "decision_analytics_runs";
CREATE TRIGGER "decision_analytics_runs_no_truncate"
BEFORE TRUNCATE ON "decision_analytics_runs"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_decision_analytics_run_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_decision_scorecard_scope_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id" THEN
    RAISE EXCEPTION 'decision scorecard scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_scorecards_scope_immutable" ON "decision_scorecards";
CREATE TRIGGER "decision_scorecards_scope_immutable"
BEFORE UPDATE OF "workspace_id", "thread_id" ON "decision_scorecards"
FOR EACH ROW EXECUTE FUNCTION "prevent_decision_scorecard_scope_mutation"();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "decision_analytics_runs" FROM PUBLIC;
