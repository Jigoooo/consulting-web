-- P2 provenance + temporal graph edges.
-- Stores typed claim/evidence/source relationships plus validity-window metadata.

CREATE TABLE IF NOT EXISTS provenance_graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  source_ref text NOT NULL,
  target_ref text NOT NULL,
  edge_type text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz,
  published_at timestamptz,
  collected_at timestamptz,
  superseded_by text,
  rationale text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS provenance_edges_workspace_idx ON provenance_graph_edges(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS provenance_edges_thread_idx ON provenance_graph_edges(thread_id, created_at);
CREATE INDEX IF NOT EXISTS provenance_edges_source_idx ON provenance_graph_edges(workspace_id, source_ref, edge_type);
CREATE INDEX IF NOT EXISTS provenance_edges_target_idx ON provenance_graph_edges(workspace_id, target_ref, edge_type);
CREATE INDEX IF NOT EXISTS provenance_edges_temporal_idx ON provenance_graph_edges(workspace_id, valid_from, valid_to);
