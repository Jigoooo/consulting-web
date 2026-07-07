CREATE TABLE IF NOT EXISTS "consulting_topic_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE cascade,
  "web_topic_id" uuid REFERENCES "topics"("id") ON DELETE cascade,
  "thread_id" uuid REFERENCES "threads"("id") ON DELETE cascade,
  "link_level" text NOT NULL,
  "consulting_topic_slug" text NOT NULL,
  "consulting_topic_id" integer,
  "scope_path" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "origin" text DEFAULT 'system' NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consulting_topic_links_project_unique"
  ON "consulting_topic_links" ("project_id")
  WHERE "link_level" = 'project' AND "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consulting_topic_links_workspace_idx" ON "consulting_topic_links" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consulting_topic_links_slug_idx" ON "consulting_topic_links" ("consulting_topic_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consulting_topic_links_scope_idx" ON "consulting_topic_links" ("project_id", "channel_id", "web_topic_id", "thread_id");
--> statement-breakpoint
INSERT INTO "consulting_topic_links" (
  "workspace_id", "project_id", "link_level", "consulting_topic_slug", "consulting_topic_id", "scope_path", "status", "origin"
)
SELECT p."workspace_id", p."id", 'project', 'changwon-org-mgmt-diagnosis', 5, p."name", 'active', 'import'
FROM "projects" p
WHERE p."deleted_at" IS NULL
  AND p."name" = '창원시 컨설팅'
  AND NOT EXISTS (
    SELECT 1 FROM "consulting_topic_links" l
    WHERE l."project_id" = p."id" AND l."link_level" = 'project' AND l."status" = 'active'
  );
--> statement-breakpoint
UPDATE "topics" t
SET "memory_topic_id" = 'consulting:changwon-org-mgmt-diagnosis#' || c."slug" || '/' || t."slug",
    "updated_at" = now()
FROM "channels" c
JOIN "projects" p ON p."id" = c."project_id"
JOIN "consulting_topic_links" l ON l."project_id" = p."id" AND l."link_level" = 'project' AND l."status" = 'active'
WHERE t."channel_id" = c."id"
  AND l."consulting_topic_slug" = 'changwon-org-mgmt-diagnosis'
  AND t."memory_topic_id" IS NULL;
