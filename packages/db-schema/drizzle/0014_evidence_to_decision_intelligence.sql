-- Evidence-to-Decision Intelligence v1.
-- Adds durable tables for claim verification, truth-maintenance invalidation,
-- decision scorecards, document retrieval units, and active review priorities.

CREATE TABLE IF NOT EXISTS claim_verification_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  claim_id text NOT NULL,
  claim_text text NOT NULL,
  evidence_ref text,
  evidence_item_id uuid REFERENCES evidence_items(id) ON DELETE SET NULL,
  verdict text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0,
  matched_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  contradicted_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text NOT NULL DEFAULT '',
  verifier text NOT NULL DEFAULT 'heuristic_v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS claim_verdicts_workspace_idx ON claim_verification_verdicts(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS claim_verdicts_thread_idx ON claim_verification_verdicts(thread_id, created_at);
CREATE INDEX IF NOT EXISTS claim_verdicts_claim_idx ON claim_verification_verdicts(claim_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS truth_maintenance_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  reason text NOT NULL,
  affected_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority_score numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS truth_maintenance_workspace_idx ON truth_maintenance_queue(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS truth_maintenance_thread_idx ON truth_maintenance_queue(thread_id, created_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS decision_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  question text NOT NULL,
  recommended_alternative_id text,
  score_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS decision_scorecards_workspace_idx ON decision_scorecards(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS decision_scorecards_thread_idx ON decision_scorecards(thread_id, created_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS decision_scorecard_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scorecard_id uuid NOT NULL REFERENCES decision_scorecards(id) ON DELETE CASCADE,
  alternative_id text NOT NULL,
  alternative_label text NOT NULL,
  weighted_score numeric NOT NULL DEFAULT 0,
  uncertainty numeric NOT NULL DEFAULT 0,
  evidence_coverage numeric NOT NULL DEFAULT 0,
  required_action text NOT NULL,
  criteria_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_items_scorecard_idx ON decision_scorecard_items(scorecard_id);
CREATE INDEX IF NOT EXISTS decision_items_workspace_idx ON decision_scorecard_items(workspace_id, weighted_score);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS document_retrieval_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  attachment_id uuid REFERENCES file_attachments(id) ON DELETE SET NULL,
  extraction_id uuid REFERENCES document_extractions(id) ON DELETE SET NULL,
  document_ref text NOT NULL,
  modality text NOT NULL,
  locator text NOT NULL,
  text_content text NOT NULL,
  score_prior numeric NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS document_units_workspace_idx ON document_retrieval_units(workspace_id, modality);
CREATE INDEX IF NOT EXISTS document_units_attachment_idx ON document_retrieval_units(attachment_id);
CREATE INDEX IF NOT EXISTS document_units_extraction_idx ON document_retrieval_units(extraction_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS active_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  item_kind text NOT NULL,
  title text NOT NULL,
  target_ref text NOT NULL,
  decision_impact numeric NOT NULL DEFAULT 0,
  uncertainty numeric NOT NULL DEFAULT 0,
  evidence_gap numeric NOT NULL DEFAULT 0,
  deadline_weight numeric NOT NULL DEFAULT 1,
  priority_score numeric NOT NULL DEFAULT 0,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS active_review_workspace_idx ON active_review_items(workspace_id, status, priority_score);
CREATE INDEX IF NOT EXISTS active_review_thread_idx ON active_review_items(thread_id, created_at);
