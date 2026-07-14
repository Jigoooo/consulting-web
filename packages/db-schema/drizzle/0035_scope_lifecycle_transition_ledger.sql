-- Atomic, restorable lifecycle-cascade ledger.
-- Each archive/soft-delete operation records every changed scope's previous
-- state in the same transaction as the scope mutations. Restores replay the
-- latest unresolved event without reviving independently archived/deleted rows.

CREATE TABLE IF NOT EXISTS scope_lifecycle_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  root_scope_type scope_type NOT NULL,
  root_scope_id uuid NOT NULL,
  operation text NOT NULL,
  scope_type scope_type NOT NULL,
  scope_id uuid NOT NULL,
  previous_status entity_status NOT NULL,
  previous_deleted_at timestamptz,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scope_lifecycle_transition_operation_check
    CHECK (operation IN ('archive', 'soft_delete')),
  CONSTRAINT scope_lifecycle_transition_root_type_check
    CHECK (root_scope_type IN ('project', 'channel', 'topic', 'thread')),
  CONSTRAINT scope_lifecycle_transition_scope_type_check
    CHECK (scope_type IN ('project', 'channel', 'topic', 'thread')),
  CONSTRAINT scope_lifecycle_transition_event_scope_unique
    UNIQUE (event_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS scope_lifecycle_transition_root_idx
  ON scope_lifecycle_transitions (root_scope_type, root_scope_id, restored_at, created_at);

CREATE INDEX IF NOT EXISTS scope_lifecycle_transition_event_idx
  ON scope_lifecycle_transitions (event_id);
