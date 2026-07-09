-- P1 retrieval query planning columns: query type, budget, scope ids, and rerank rank audit.

ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS query_type text NOT NULL DEFAULT 'general';
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS retrieval_mode text NOT NULL DEFAULT 'graphrag_fanout';
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS top_k integer NOT NULL DEFAULT 8;
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS evidence_sufficiency_status text;
ALTER TABLE retrieval_runs ADD COLUMN IF NOT EXISTS required_action text;

ALTER TABLE retrieval_hits ADD COLUMN IF NOT EXISTS rank_before_rerank integer;
ALTER TABLE retrieval_hits ADD COLUMN IF NOT EXISTS rank_after_rerank integer;

CREATE INDEX IF NOT EXISTS retrieval_runs_scope_idx ON retrieval_runs(workspace_id, project_id, channel_id, topic_id, created_at);
CREATE INDEX IF NOT EXISTS retrieval_runs_query_type_idx ON retrieval_runs(workspace_id, query_type, created_at);
