-- Lifecycle/tombstone safety for graph edges/tags.
-- Archived scopes remain referenceable; deleted_soft scopes tombstone their graph rows.

ALTER TABLE context_edges ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE scope_tags ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS context_edges_to_idx ON context_edges(to_scope_type, to_scope_id);
CREATE INDEX IF NOT EXISTS context_edges_deleted_at_idx ON context_edges(deleted_at);
CREATE INDEX IF NOT EXISTS scope_tags_deleted_at_idx ON scope_tags(deleted_at);

-- Backfill legacy soft-deleted scope rows so status reflects the existing deleted_at flag.
UPDATE projects SET status='deleted_soft', updated_at=now()
WHERE deleted_at IS NOT NULL AND status <> 'deleted_soft';
UPDATE channels SET status='deleted_soft', updated_at=now()
WHERE deleted_at IS NOT NULL AND status <> 'deleted_soft';
UPDATE topics SET status='deleted_soft', updated_at=now()
WHERE deleted_at IS NOT NULL AND status <> 'deleted_soft';
UPDATE threads SET status='deleted_soft', updated_at=now()
WHERE deleted_at IS NOT NULL AND status <> 'deleted_soft';
