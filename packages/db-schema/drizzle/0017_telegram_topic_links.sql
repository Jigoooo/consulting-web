-- Exact Telegram forum-topic mapping into consulting-web scopes.
-- Order-08 is schema/service/dry-run only; applying this migration is a DB mutation gate.

CREATE TABLE IF NOT EXISTS telegram_topic_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  web_topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL,
  telegram_thread_id text NOT NULL,
  telegram_topic_name text NOT NULL,
  consulting_topic_slug text NOT NULL,
  memory_topic_id text NOT NULL,
  profile_source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_topic_links_status_chk CHECK (status IN ('active', 'archived')),
  CONSTRAINT telegram_topic_links_profile_source_chk CHECK (profile_source IN ('manual', 'template', 'inferred')),
  CONSTRAINT telegram_topic_links_exact_thread_chk CHECK (telegram_thread_id <> '')
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS telegram_topic_links_unique
  ON telegram_topic_links(telegram_chat_id, telegram_thread_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS telegram_topic_links_project_idx
  ON telegram_topic_links(project_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS telegram_topic_links_scope_idx
  ON telegram_topic_links(channel_id, web_topic_id, thread_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS telegram_topic_links_memory_topic_idx
  ON telegram_topic_links(memory_topic_id);
