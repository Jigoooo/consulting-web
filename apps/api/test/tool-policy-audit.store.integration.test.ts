import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { buildToolPolicyAudit, evaluateToolPolicy } from '../src/security/tool-policy.js';
import { ToolPolicyAuditStore } from '../src/security/tool-policy-audit.store.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const userId = randomUUID();
const workspaceId = randomUUID();

function audit(runId: string, toolsets: string[], decidedAtIso: string) {
  const result = evaluateToolPolicy({ enabledToolsets: toolsets, baseAllowlist: ['web', 'file'] });
  return buildToolPolicyAudit({ workspaceId, runId, decidedAtIso }, result, toolsets, sha);
}

d('ToolPolicyAuditStore', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'tool-policy-audit' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'tool-policy-audit', slug: `tpa-${workspaceId}`, ownerUserId: userId });
  });

  afterAll(async () => {
    const trigger = await pool.query(
      "SELECT 1 FROM pg_trigger WHERE tgrelid = 'tool_policy_audit_events'::regclass AND tgname = 'tool_policy_audit_events_no_update_delete'",
    );
    if (trigger.rowCount === 1) {
      await pool.query('ALTER TABLE tool_policy_audit_events DISABLE TRIGGER tool_policy_audit_events_no_update_delete');
    }
    await db.delete(schema.toolPolicyAuditEvents).where(eq(schema.toolPolicyAuditEvents.workspaceId, workspaceId));
    if (trigger.rowCount === 1) {
      await pool.query('ALTER TABLE tool_policy_audit_events ENABLE TRIGGER tool_policy_audit_events_no_update_delete');
    }
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('serializes concurrent events into one verifiable chain and rejects replay drift', async () => {
    const store = new ToolPolicyAuditStore(db as never);
    const first = audit('run-1', ['web'], '2026-07-13T00:00:00.000Z');
    const inserted = await store.record(first);
    expect(inserted.idempotent).toBe(false);
    await expect(store.record(first)).resolves.toEqual({ eventHash: inserted.eventHash, idempotent: true });
    await expect(store.record({ ...first, auditHash: 'f'.repeat(64) })).rejects.toThrow('replay mismatch');

    await Promise.all([
      store.record(audit('run-2', ['web'], '2026-07-12T00:00:00.000Z')),
      store.record(audit('run-3', ['file'], '2026-07-14T00:00:00.000Z')),
    ]);
    const rows = await db.select({
      sequenceNo: schema.toolPolicyAuditEvents.sequenceNo,
      previousHash: schema.toolPolicyAuditEvents.previousHash,
      eventHash: schema.toolPolicyAuditEvents.eventHash,
    }).from(schema.toolPolicyAuditEvents)
      .where(eq(schema.toolPolicyAuditEvents.workspaceId, workspaceId))
      .orderBy(asc(schema.toolPolicyAuditEvents.sequenceNo));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.previousHash).toBeNull();
    expect(rows[1]?.previousHash).toBe(rows[0]?.eventHash);
    expect(rows[2]?.previousHash).toBe(rows[1]?.eventHash);
    await expect(store.verifyWorkspaceChain(workspaceId)).resolves.toEqual({ valid: true, count: 3 });

    const trigger = await pool.query(
      "SELECT 1 FROM pg_trigger WHERE tgrelid = 'tool_policy_audit_events'::regclass AND tgname = 'tool_policy_audit_events_no_update_delete'",
    );
    const mutation = db.update(schema.toolPolicyAuditEvents)
      .set({ decision: 'deny' })
      .where(and(
        eq(schema.toolPolicyAuditEvents.workspaceId, workspaceId),
        eq(schema.toolPolicyAuditEvents.runId, 'run-2'),
      ));
    if (trigger.rowCount === 1) {
      await expect(mutation).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining('append-only') }),
      });
      await expect(store.verifyWorkspaceChain(workspaceId)).resolves.toEqual({ valid: true, count: 3 });
    } else {
      await mutation;
      await expect(store.verifyWorkspaceChain(workspaceId)).resolves.toEqual(expect.objectContaining({
        valid: false,
        count: 3,
        reason: 'policy_hash',
      }));
    }

    await expect(db.insert(schema.toolPolicyAuditEvents).values({
      workspaceId,
      runId: 'run-invalid',
      decision: 'allow',
      enabledToolsets: [],
      allowedToolsets: [],
      blockedToolsets: [],
      rejectedHighBlastGrants: [],
      enforced: true,
      policyHash: 'invalid',
      previousHash: null,
      eventHash: 'invalid',
      decidedAt: new Date(),
    })).rejects.toThrow();
  });
});
