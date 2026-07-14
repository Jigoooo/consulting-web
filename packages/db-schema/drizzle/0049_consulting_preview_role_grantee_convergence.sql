-- Converge both inbound memberships and outbound grantees for the V3-5 preview role.
ALTER ROLE consulting_preview_ro
  NOLOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;
--> statement-breakpoint
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
    WHERE granted.rolname = 'consulting_preview_ro' AND member_role.rolname <> 'consulting'
  LOOP
    EXECUTE format('REVOKE consulting_preview_ro FROM %I', grantee_role.rolname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'consulting_preview_ro'::regrole)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = 'consulting_preview_ro'::regrole)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = 'consulting_preview_ro'::regrole)
     OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = 'consulting_preview_ro'::regrole) THEN
    RAISE EXCEPTION 'consulting_preview_ro owns database objects and cannot be safely converged';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM consulting_preview_ro;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM consulting_preview_ro;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM consulting_preview_ro;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SCHEMA public FROM consulting_preview_ro;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO consulting_preview_ro;
--> statement-breakpoint
GRANT SELECT ON TABLE
  telegram_message_imports,
  chat_messages,
  telegram_topic_links,
  workspaces,
  projects,
  channels,
  topics,
  threads
TO consulting_preview_ro;
--> statement-breakpoint
GRANT consulting_preview_ro TO consulting;
--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT array_agg(member_role.rolname ORDER BY member_role.rolname)
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE granted.rolname = 'consulting_preview_ro')
     IS DISTINCT FROM ARRAY['consulting']::name[] THEN
    RAISE EXCEPTION 'consulting_preview_ro grantee set failed to converge';
  END IF;
END
$$;
