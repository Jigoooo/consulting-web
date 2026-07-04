-- ADR-0001/0005: outbox events are tenant-scoped state-change records.
-- Prevent tenantless relay events that would bypass workspace cleanup/RLS/audit joins.
ALTER TABLE "outbox_events" ALTER COLUMN "workspace_id" SET NOT NULL;

-- Matches relay scan: WHERE status = 'pending' ORDER BY created_at LIMIT n.
CREATE INDEX IF NOT EXISTS "outbox_status_created_idx"
  ON "outbox_events" ("status", "created_at");
