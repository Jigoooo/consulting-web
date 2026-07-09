-- P0 retrieval ledger: every GraphRAG recall should leave auditable run/hit rows.

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  query_hash text NOT NULL,
  query_text text NOT NULL,
  recall_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  hit_count integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  rerank text,
  rerank_error text,
  signals jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS retrieval_runs_workspace_idx ON retrieval_runs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS retrieval_runs_thread_idx ON retrieval_runs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS retrieval_runs_trace_idx ON retrieval_runs(workspace_id, trace_id);
CREATE INDEX IF NOT EXISTS retrieval_runs_status_idx ON retrieval_runs(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS retrieval_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  retrieval_run_id uuid NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  rank integer NOT NULL,
  hit_kind text NOT NULL,
  source_topic_slug text,
  source_relation text,
  source_weight numeric,
  score numeric,
  fused_score numeric,
  rerank_score numeric,
  adjusted_score numeric,
  doc_title text,
  utility_tier text,
  text_preview text NOT NULL,
  linked jsonb NOT NULL DEFAULT '[]'::jsonb,
  signal_breakdown jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS retrieval_hits_workspace_idx ON retrieval_hits(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS retrieval_hits_run_idx ON retrieval_hits(retrieval_run_id, rank);
CREATE INDEX IF NOT EXISTS retrieval_hits_thread_idx ON retrieval_hits(thread_id, created_at);
CREATE INDEX IF NOT EXISTS retrieval_hits_source_idx ON retrieval_hits(workspace_id, source_topic_slug);
