-- Multimodal/document-unit embedding ledger. Review before applying; live DB apply is approval-gated.

CREATE TABLE IF NOT EXISTS document_unit_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_unit_id uuid NOT NULL REFERENCES document_retrieval_units(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  embedding_dim integer NOT NULL DEFAULT 0,
  input_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'fallback',
  fallback_reason text,
  embedding jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT document_unit_embeddings_status_chk CHECK (status IN ('ok', 'fallback', 'disabled', 'failed'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS document_unit_embeddings_unit_provider_input_uq
  ON document_unit_embeddings(document_unit_id, provider, input_sha256);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS document_unit_embeddings_workspace_idx
  ON document_unit_embeddings(workspace_id, provider, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS document_unit_embeddings_unit_idx
  ON document_unit_embeddings(document_unit_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS document_unit_embeddings_status_idx
  ON document_unit_embeddings(workspace_id, status, created_at);
