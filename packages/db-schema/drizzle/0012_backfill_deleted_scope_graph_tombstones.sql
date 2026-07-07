-- Backfill graph tombstones for legacy deleted_soft scopes.
-- Existing lifecycle code tombstones future soft-deletes, but rows that were
-- soft-deleted before 0010 can still have live context_edges/scope_tags.
-- This migration is idempotent and non-destructive: it only sets deleted_at.

WITH deleted_scopes AS (
  SELECT 'project'::scope_type AS scope_type, id AS scope_id FROM projects WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'channel'::scope_type, id FROM channels WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'topic'::scope_type, id FROM topics WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'thread'::scope_type, id FROM threads WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
), touched AS (
  SELECT now() AS at
)
UPDATE context_edges e
SET deleted_at = touched.at, updated_at = touched.at
FROM touched
WHERE e.deleted_at IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM deleted_scopes s
      WHERE s.scope_type = e.from_scope_type AND s.scope_id = e.from_scope_id
    )
    OR EXISTS (
      SELECT 1 FROM deleted_scopes s
      WHERE s.scope_type = e.to_scope_type AND s.scope_id = e.to_scope_id
    )
  );

WITH deleted_scopes AS (
  SELECT 'project'::scope_type AS scope_type, id AS scope_id FROM projects WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'channel'::scope_type, id FROM channels WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'topic'::scope_type, id FROM topics WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
  UNION ALL
  SELECT 'thread'::scope_type, id FROM threads WHERE deleted_at IS NOT NULL OR status = 'deleted_soft'
), touched AS (
  SELECT now() AS at
)
UPDATE scope_tags st
SET deleted_at = touched.at, updated_at = touched.at
FROM deleted_scopes s, touched
WHERE st.deleted_at IS NULL
  AND st.scope_type = s.scope_type
  AND st.scope_id = s.scope_id;
