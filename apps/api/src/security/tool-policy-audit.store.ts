import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { computeToolPolicyAuditHash, type ToolPolicyAuditRecord } from './tool-policy.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export function toolPolicyChainHash(input: {
  workspaceId: string;
  runId: string;
  policyHash: string;
  previousHash: string | null;
  decidedAtIso: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId,
    runId: input.runId,
    policyHash: input.policyHash,
    previousHash: input.previousHash,
    decidedAtIso: input.decidedAtIso,
  })).digest('hex');
}

@Injectable()
export class ToolPolicyAuditStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(record: ToolPolicyAuditRecord): Promise<{ eventHash: string; idempotent: boolean }> {
    if (!record.runId) throw new Error('tool policy audit requires runId');
    const runId = record.runId;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${record.workspaceId}))`);
      const [existing] = await tx
        .select({ policyHash: schema.toolPolicyAuditEvents.policyHash, eventHash: schema.toolPolicyAuditEvents.eventHash })
        .from(schema.toolPolicyAuditEvents)
        .where(and(
          eq(schema.toolPolicyAuditEvents.workspaceId, record.workspaceId),
          eq(schema.toolPolicyAuditEvents.runId, runId),
        ))
        .limit(1);
      if (existing) {
        if (existing.policyHash !== record.auditHash) throw new Error('tool policy audit run replay mismatch');
        return { eventHash: existing.eventHash, idempotent: true };
      }
      const [latest] = await tx
        .select({ eventHash: schema.toolPolicyAuditEvents.eventHash })
        .from(schema.toolPolicyAuditEvents)
        .where(eq(schema.toolPolicyAuditEvents.workspaceId, record.workspaceId))
        .orderBy(desc(schema.toolPolicyAuditEvents.sequenceNo))
        .limit(1);
      const previousHash = latest?.eventHash ?? null;
      const eventHash = toolPolicyChainHash({
        workspaceId: record.workspaceId,
        runId,
        policyHash: record.auditHash,
        previousHash,
        decidedAtIso: record.decidedAtIso,
      });
      await tx.insert(schema.toolPolicyAuditEvents).values({
        workspaceId: record.workspaceId,
        runId,
        decision: record.decision,
        enabledToolsets: record.enabledToolsets,
        allowedToolsets: record.allowedToolsets,
        blockedToolsets: record.blockedToolsets,
        rejectedHighBlastGrants: record.rejectedHighBlastGrants,
        enforced: record.enforced,
        policyHash: record.auditHash,
        previousHash,
        eventHash,
        decidedAt: new Date(record.decidedAtIso),
      });
      return { eventHash, idempotent: false };
    });
  }

  async verifyWorkspaceChain(workspaceId: string): Promise<{
    valid: boolean;
    count: number;
    errorAtSequence?: number;
    reason?: 'policy_hash' | 'previous_hash' | 'event_hash' | 'sequence';
  }> {
    const rows = await this.db
      .select({
        sequenceNo: schema.toolPolicyAuditEvents.sequenceNo,
        runId: schema.toolPolicyAuditEvents.runId,
        decision: schema.toolPolicyAuditEvents.decision,
        enabledToolsets: schema.toolPolicyAuditEvents.enabledToolsets,
        allowedToolsets: schema.toolPolicyAuditEvents.allowedToolsets,
        blockedToolsets: schema.toolPolicyAuditEvents.blockedToolsets,
        rejectedHighBlastGrants: schema.toolPolicyAuditEvents.rejectedHighBlastGrants,
        enforced: schema.toolPolicyAuditEvents.enforced,
        policyHash: schema.toolPolicyAuditEvents.policyHash,
        previousHash: schema.toolPolicyAuditEvents.previousHash,
        eventHash: schema.toolPolicyAuditEvents.eventHash,
        decidedAt: schema.toolPolicyAuditEvents.decidedAt,
      })
      .from(schema.toolPolicyAuditEvents)
      .where(eq(schema.toolPolicyAuditEvents.workspaceId, workspaceId))
      .orderBy(asc(schema.toolPolicyAuditEvents.sequenceNo));
    let previousHash: string | null = null;
    let previousSequence: number | null = null;
    for (const row of rows) {
      if (previousSequence !== null && row.sequenceNo <= previousSequence) {
        return { valid: false, count: rows.length, errorAtSequence: row.sequenceNo, reason: 'sequence' };
      }
      let policyHash: string;
      try {
        policyHash = computeToolPolicyAuditHash({
          workspaceId,
          runId: row.runId,
          decision: row.decision as 'allow' | 'deny',
          enabledToolsets: row.enabledToolsets,
          allowedToolsets: row.allowedToolsets,
          blockedToolsets: row.blockedToolsets,
          rejectedHighBlastGrants: row.rejectedHighBlastGrants,
          enforced: row.enforced,
        }, (payload) => createHash('sha256').update(payload).digest('hex'));
      } catch {
        return { valid: false, count: rows.length, errorAtSequence: row.sequenceNo, reason: 'policy_hash' };
      }
      if (policyHash !== row.policyHash) {
        return { valid: false, count: rows.length, errorAtSequence: row.sequenceNo, reason: 'policy_hash' };
      }
      if (row.previousHash !== previousHash) {
        return { valid: false, count: rows.length, errorAtSequence: row.sequenceNo, reason: 'previous_hash' };
      }
      const eventHash = toolPolicyChainHash({
        workspaceId,
        runId: row.runId,
        policyHash: row.policyHash,
        previousHash: row.previousHash,
        decidedAtIso: row.decidedAt.toISOString(),
      });
      if (eventHash !== row.eventHash) {
        return { valid: false, count: rows.length, errorAtSequence: row.sequenceNo, reason: 'event_hash' };
      }
      previousHash = row.eventHash;
      previousSequence = row.sequenceNo;
    }
    return { valid: true, count: rows.length };
  }
}
