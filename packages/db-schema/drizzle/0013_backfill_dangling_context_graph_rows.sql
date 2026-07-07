-- Backfill graph tombstones for rows whose polymorphic scope endpoint no longer exists.
-- context_edges/scope_tags do not have physical FKs because scope_id is polymorphic,
-- so older workspace/user cleanup can leave live dangling graph rows. This is
-- idempotent and non-destructive: it only sets deleted_at/updated_at.

WITH all_scopes AS (
  SELECT 'project'::scope_type AS scope_type, id AS scope_id FROM projects
  UNION ALL
  SELECT 'channel'::scope_type, id FROM channels
  UNION ALL
  SELECT 'topic'::scope_type, id FROM topics
  UNION ALL
  SELECT 'thread'::scope_type, id FROM threads
), touched AS (
  SELECT now() AS at
)
UPDATE context_edges e
SET deleted_at = touched.at, updated_at = touched.at
FROM touched
WHERE e.deleted_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1 FROM all_scopes s
      WHERE s.scope_type = e.from_scope_type AND s.scope_id = e.from_scope_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM all_scopes s
      WHERE s.scope_type = e.to_scope_type AND s.scope_id = e.to_scope_id
    )
  );

--> statement-breakpoint

WITH all_scopes AS (
  SELECT 'project'::scope_type AS scope_type, id AS scope_id FROM projects
  UNION ALL
  SELECT 'channel'::scope_type, id FROM channels
  UNION ALL
  SELECT 'topic'::scope_type, id FROM topics
  UNION ALL
  SELECT 'thread'::scope_type, id FROM threads
), touched AS (
  SELECT now() AS at
)
UPDATE scope_tags st
SET deleted_at = touched.at, updated_at = touched.at
FROM touched
WHERE st.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM all_scopes s
    WHERE s.scope_type = st.scope_type AND s.scope_id = st.scope_id
  );
