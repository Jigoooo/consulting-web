-- P3 local trace/eval substrate. No external Phoenix/Langfuse dependency.

CREATE TABLE IF NOT EXISTS trace_spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  parent_span_id uuid,
  span_kind text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_ms integer NOT NULL DEFAULT 0,
  input jsonb,
  output jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS trace_spans_workspace_idx ON trace_spans(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS trace_spans_trace_idx ON trace_spans(workspace_id, trace_id, started_at);
CREATE INDEX IF NOT EXISTS trace_spans_thread_idx ON trace_spans(thread_id, created_at);
CREATE INDEX IF NOT EXISTS trace_spans_kind_idx ON trace_spans(workspace_id, span_kind, started_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  case_kind text NOT NULL,
  source_ref text NOT NULL,
  prompt text NOT NULL,
  expected jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT eval_cases_source_uq UNIQUE (workspace_id, case_kind, source_ref)
);

CREATE INDEX IF NOT EXISTS eval_cases_workspace_idx ON eval_cases(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS eval_cases_thread_idx ON eval_cases(thread_id, created_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_kind text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS eval_runs_workspace_idx ON eval_runs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS eval_runs_kind_idx ON eval_runs(workspace_id, run_kind, created_at);
CREATE INDEX IF NOT EXISTS eval_runs_status_idx ON eval_runs(workspace_id, status, created_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS eval_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  eval_run_id uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  eval_case_id uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  metric_name text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  passed boolean NOT NULL DEFAULT false,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT eval_scores_run_case_metric_uq UNIQUE (eval_run_id, eval_case_id, metric_name)
);

CREATE INDEX IF NOT EXISTS eval_scores_workspace_idx ON eval_scores(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS eval_scores_run_idx ON eval_scores(eval_run_id, metric_name);
CREATE INDEX IF NOT EXISTS eval_scores_case_idx ON eval_scores(eval_case_id);
