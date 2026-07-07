-- Channel/topic prompt-profile metadata for consulting-web spaces.
-- Runtime service validates polymorphic scope_id against live channel/topic rows.

CREATE TABLE IF NOT EXISTS scope_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type scope_type NOT NULL,
  scope_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT '',
  rules text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT scope_profiles_scope_kind_chk CHECK (scope_type IN ('channel', 'topic')),
  CONSTRAINT scope_profiles_source_chk CHECK (source IN ('template', 'manual', 'inferred'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS scope_profiles_scope_unique
  ON scope_profiles(workspace_id, scope_type, scope_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS scope_profiles_workspace_idx
  ON scope_profiles(workspace_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS scope_profiles_scope_idx
  ON scope_profiles(scope_type, scope_id);
