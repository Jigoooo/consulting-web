-- W1 §3.4: retrieval hit relevance labels — precision-improvement data foundation.
-- Additive only: two nullable columns + a partial index. No backfill, no path change.
-- judged_relevant: human/verifier feedback on whether this hit was actually relevant.
-- failure_type: taxonomy label when a hit was wrong (wrong_project, raw_over_selected, ...).

ALTER TABLE retrieval_hits ADD COLUMN IF NOT EXISTS judged_relevant boolean;
ALTER TABLE retrieval_hits ADD COLUMN IF NOT EXISTS failure_type text;

CREATE INDEX IF NOT EXISTS retrieval_hits_label_idx
  ON retrieval_hits(workspace_id, failure_type)
  WHERE failure_type IS NOT NULL;
