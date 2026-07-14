ALTER TABLE "retrieval_runs"
  ADD CONSTRAINT "retrieval_runs_scope_unique"
  UNIQUE ("id", "workspace_id", "thread_id");

ALTER TABLE "retrieval_hits"
  ADD CONSTRAINT "retrieval_hits_run_scope_fk"
  FOREIGN KEY ("retrieval_run_id", "workspace_id", "thread_id")
  REFERENCES "retrieval_runs" ("id", "workspace_id", "thread_id")
  ON DELETE CASCADE;

ALTER TABLE "retrieval_hits"
  ADD CONSTRAINT "retrieval_hits_failure_type_check"
  CHECK (
    "failure_type" IS NULL OR "failure_type" IN (
      'wrong_project', 'wrong_topic', 'wrong_phase', 'wrong_client',
      'raw_over_selected', 'lexical_false_positive', 'semantic_false_positive',
      'graph_over_fanout', 'stale_source', 'unsupported_claim', 'citation_missing',
      'duplicate_chunk', 'too_generic_context', 'query_rewrite_error', 'reranker_error'
    )
  );

ALTER TABLE "retrieval_hits"
  ADD CONSTRAINT "retrieval_hits_label_pair_check"
  CHECK (
    ("judged_relevant" IS NULL AND "failure_type" IS NULL)
    OR ("judged_relevant" = true AND "failure_type" IS NULL)
    OR ("judged_relevant" = false AND "failure_type" IS NOT NULL)
  );
