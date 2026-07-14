-- V3-4 denominator hardening: acceptance is durable before retrieval starts.
-- Retrieval provenance is attached later with an exact pending-row CAS.
ALTER TABLE "consulting_insight_shadow_turns"
  ALTER COLUMN "retrieval_run_id" DROP NOT NULL,
  ALTER COLUMN "retrieval_snapshot_hash" DROP NOT NULL;
