-- Converge preview-role membership direction and PostgreSQL 16 grant options.
DO $$
DECLARE
  parent_role record;
  grantee_role record;
BEGIN
  FOR parent_role IN
    SELECT granted.rolname
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'consulting_preview_ro'
  LOOP
    EXECUTE format('REVOKE %I FROM consulting_preview_ro', parent_role.rolname);
  END LOOP;
  FOR grantee_role IN
    SELECT member_role.rolname
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted.rolname = 'consulting_preview_ro'
      AND member_role.rolname <> 'consulting'
  LOOP
    EXECUTE format('REVOKE consulting_preview_ro FROM %I', grantee_role.rolname);
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE consulting_preview_ro FROM consulting;
--> statement-breakpoint
GRANT consulting_preview_ro TO consulting
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = 'consulting_preview_ro'::regrole
  ) THEN
    RAISE EXCEPTION 'consulting_preview_ro inherited parent roles after convergence';
  END IF;
  IF (SELECT count(*) FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE granted.rolname = 'consulting_preview_ro') <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member_role ON member_role.oid = membership.member
       WHERE granted.rolname = 'consulting_preview_ro'
         AND member_role.rolname = 'consulting'
         AND membership.admin_option = false
         AND membership.inherit_option = false
         AND membership.set_option = true
     ) THEN
    RAISE EXCEPTION 'consulting_preview_ro membership options failed to converge';
  END IF;
END
$$;
