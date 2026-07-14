CREATE TRIGGER migration_checksum_baselines_truncate_immutable
BEFORE TRUNCATE ON migration_checksum_baselines
FOR EACH STATEMENT EXECUTE FUNCTION reject_migration_checksum_baseline_mutation();
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON migration_checksum_baselines FROM PUBLIC;
