-- V3 scope isolation: promote an explicit active Telegram topic binding into the
-- consulting-web resolver's exact topic-level capability ledger.
-- This is additive: legacy message rows and existing links are never rewritten.
INSERT INTO consulting_topic_links (
  workspace_id,
  project_id,
  channel_id,
  web_topic_id,
  thread_id,
  link_level,
  consulting_topic_slug,
  scope_path,
  status,
  origin
)
SELECT
  l.workspace_id,
  l.project_id,
  l.channel_id,
  l.web_topic_id,
  NULL,
  'topic',
  l.consulting_topic_slug,
  'telegram/' || l.telegram_chat_id || '/' || l.telegram_thread_id,
  'active',
  'import'
FROM telegram_topic_links AS l
JOIN workspaces AS w
  ON w.id = l.workspace_id
 AND w.status = 'active'
 AND w.deleted_at IS NULL
JOIN projects AS p
  ON p.id = l.project_id
 AND p.workspace_id = l.workspace_id
 AND p.status = 'active'
 AND p.deleted_at IS NULL
JOIN channels AS c
  ON c.id = l.channel_id
 AND c.workspace_id = l.workspace_id
 AND c.project_id = l.project_id
 AND c.status = 'active'
 AND c.deleted_at IS NULL
JOIN topics AS t
  ON t.id = l.web_topic_id
 AND t.workspace_id = l.workspace_id
 AND t.channel_id = l.channel_id
 AND t.status = 'active'
 AND t.deleted_at IS NULL
JOIN threads AS th
  ON th.id = l.thread_id
 AND th.workspace_id = l.workspace_id
 AND th.topic_id = l.web_topic_id
 AND th.status = 'active'
 AND th.deleted_at IS NULL
WHERE l.status = 'active'
  AND l.telegram_chat_id IS NOT NULL
  AND l.telegram_thread_id IS NOT NULL
  AND l.web_topic_id IS NOT NULL
  AND l.thread_id IS NOT NULL
  AND l.consulting_topic_slug IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM consulting_topic_links AS existing
    WHERE existing.workspace_id = l.workspace_id
      AND existing.project_id = l.project_id
      AND existing.web_topic_id = l.web_topic_id
      AND existing.link_level = 'topic'
      AND existing.status = 'active'
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS consulting_topic_links_topic_active_unique
  ON consulting_topic_links (web_topic_id)
  WHERE link_level = 'topic' AND status = 'active';
