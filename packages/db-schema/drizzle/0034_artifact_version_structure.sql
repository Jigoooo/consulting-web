ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS governing_message text;
--> statement-breakpoint
ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS so_what text;
--> statement-breakpoint
ALTER TABLE artifact_versions
  DROP CONSTRAINT IF EXISTS artifact_versions_structure_check;
--> statement-breakpoint
ALTER TABLE artifact_versions
  ADD CONSTRAINT artifact_versions_structure_check
  CHECK (
    (governing_message IS NULL AND so_what IS NULL)
    OR (
      governing_message IS NOT NULL
      AND so_what IS NOT NULL
      AND char_length(btrim(governing_message)) BETWEEN 10 AND 500
      AND char_length(btrim(so_what)) BETWEEN 10 AND 1000
    )
  );
