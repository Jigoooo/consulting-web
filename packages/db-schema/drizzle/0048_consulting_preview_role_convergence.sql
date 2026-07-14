-- Re-converge the already deployed V3-5 preview role to a least-privilege state.
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
