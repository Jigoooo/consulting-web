BEGIN;

ALTER TABLE retrieval_hits
  DROP CONSTRAINT IF EXISTS retrieval_hits_label_pair_check;

ALTER TABLE retrieval_hits
  ADD CONSTRAINT retrieval_hits_label_pair_check
  CHECK (
    (judged_relevant IS NULL AND failure_type IS NULL)
    OR (judged_relevant IS TRUE AND failure_type IS NULL)
    OR (judged_relevant IS FALSE AND failure_type IS NOT NULL)
  ) NOT VALID;

ALTER TABLE retrieval_hits
  VALIDATE CONSTRAINT retrieval_hits_label_pair_check;

COMMENT ON CONSTRAINT retrieval_hits_label_pair_check ON retrieval_hits IS
  'Relevance labels are fail-closed under SQL three-valued logic: unlabeled has no failure type; relevant has no failure type; non-relevant requires one.';

COMMIT;
