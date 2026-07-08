-- Allow project-level profile metadata used by the project creation wizard and settings modal.
-- 0016 originally constrained scope_profiles to channel/topic only.

ALTER TABLE scope_profiles
  DROP CONSTRAINT IF EXISTS scope_profiles_scope_kind_chk;

--> statement-breakpoint

ALTER TABLE scope_profiles
  ADD CONSTRAINT scope_profiles_scope_kind_chk
  CHECK (scope_type IN ('project', 'channel', 'topic'));
