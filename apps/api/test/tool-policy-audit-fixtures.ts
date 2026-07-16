import type { Pool } from 'pg';

export async function deleteToolPolicyAuditFixtures(pool: Pool, workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE tool_policy_audit_events DISABLE TRIGGER tool_policy_audit_events_no_update_delete');
    await client.query(
      'DELETE FROM tool_policy_audit_events WHERE workspace_id = ANY($1::uuid[])',
      [workspaceIds],
    );
    await client.query('ALTER TABLE tool_policy_audit_events ENABLE TRIGGER tool_policy_audit_events_no_update_delete');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
