-- Tool-policy security history is retained independently of mutable workspace lifecycle.
-- Runtime writers may INSERT through ToolPolicyAuditStore only; historical rows are append-only.

ALTER TABLE "tool_policy_audit_events"
  DROP CONSTRAINT IF EXISTS "tool_policy_audit_events_workspace_id_workspaces_id_fk";
ALTER TABLE "tool_policy_audit_events"
  DROP CONSTRAINT IF EXISTS "tool_policy_audit_events_workspace_id_fkey";

ALTER TABLE "tool_policy_audit_events"
  ADD CONSTRAINT "tool_policy_audit_events_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION "prevent_tool_policy_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tool_policy_audit_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS "tool_policy_audit_events_no_update_delete"
  ON "tool_policy_audit_events";
CREATE TRIGGER "tool_policy_audit_events_no_update_delete"
BEFORE UPDATE OR DELETE ON "tool_policy_audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_tool_policy_audit_mutation"();

DROP TRIGGER IF EXISTS "tool_policy_audit_events_no_truncate"
  ON "tool_policy_audit_events";
CREATE TRIGGER "tool_policy_audit_events_no_truncate"
BEFORE TRUNCATE ON "tool_policy_audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_tool_policy_audit_mutation"();

COMMENT ON TABLE "tool_policy_audit_events" IS
  'Append-only, tamper-evident tool-policy decision chain; workspace deletion is restricted while audit history exists.';
