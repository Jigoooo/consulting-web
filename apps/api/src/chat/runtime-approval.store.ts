import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const RUNTIME_APPROVAL_TTL_MS = 10 * 60 * 1000;
const RUNTIME_APPROVAL_ACTION = 'hermes_runtime_tool_approval';

type RuntimeApprovalRisk = 'low' | 'medium' | 'high' | 'critical';
export type RuntimeApprovalChoice = 'once' | 'session' | 'deny';

export interface RuntimeApprovalPayload {
  readonly kind: 'hermes_runtime_approval';
  readonly version: 1;
  readonly runId: string;
  readonly threadId: string;
  readonly actionHash: string;
  readonly toolId: string;
  readonly command: string | null;
  readonly message: string | null;
  readonly risk: string | null;
  readonly choices: readonly string[];
  readonly requestedAt: string;
}

export type RuntimeApprovalDecisionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_pending' | 'expired' | 'mismatch' };

export function runtimeApprovalActionHash(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly command?: string;
  readonly message?: string;
  readonly risk?: string;
  readonly choices: readonly string[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      runId: input.runId,
      threadId: input.threadId,
      command: input.command ?? null,
      message: input.message ?? null,
      risk: input.risk ?? null,
      choices: [...input.choices].sort(),
    }))
    .digest('hex');
}

function runtimeApprovalRisk(value: string | undefined): RuntimeApprovalRisk {
  const raw = value?.toLowerCase() ?? '';
  if (raw.includes('critical')) return 'critical';
  if (raw.includes('high')) return 'high';
  if (raw.includes('low')) return 'low';
  return 'medium';
}

function inferToolId(command: string | undefined, message: string | undefined): string {
  const source = (command ?? message ?? 'unknown').trim();
  const first = source.split(/\s+/u)[0] ?? 'unknown';
  return first.replace(/[^a-zA-Z0-9_.:-]/gu, '').slice(0, 120) || 'unknown';
}

function approvalPayload(value: unknown): RuntimeApprovalPayload | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<RuntimeApprovalPayload>;
  if (item.kind !== 'hermes_runtime_approval' || item.version !== 1) return null;
  if (typeof item.runId !== 'string' || typeof item.threadId !== 'string') return null;
  if (typeof item.actionHash !== 'string' || typeof item.toolId !== 'string') return null;
  return item as RuntimeApprovalPayload;
}

@Injectable()
export class RuntimeApprovalStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createRuntimeApproval(input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly requestedByUserId: string;
    readonly runId: string;
    readonly command?: string;
    readonly message?: string;
    readonly risk?: string;
    readonly choices: readonly string[];
  }): Promise<{ readonly approvalId: string; readonly actionHash: string }> {
    await this.assertThreadInWorkspace(input.workspaceId, input.threadId);
    const now = new Date();
    const actionHash = runtimeApprovalActionHash(input);
    const payload: RuntimeApprovalPayload = {
      kind: 'hermes_runtime_approval',
      version: 1,
      runId: input.runId,
      threadId: input.threadId,
      actionHash,
      toolId: inferToolId(input.command, input.message),
      command: input.command ?? null,
      message: input.message ?? null,
      risk: input.risk ?? null,
      choices: [...input.choices],
      requestedAt: now.toISOString(),
    };
    const [row] = await this.db.insert(schema.approvalRequests).values({
      workspaceId: input.workspaceId,
      requestedByUserId: input.requestedByUserId,
      actionType: RUNTIME_APPROVAL_ACTION,
      payload,
      riskLevel: runtimeApprovalRisk(input.risk),
      status: 'pending',
      expiresAt: new Date(now.getTime() + RUNTIME_APPROVAL_TTL_MS),
    }).returning({ id: schema.approvalRequests.id });
    if (!row) throw new Error('runtime approval insert failed');
    return { approvalId: row.id, actionHash };
  }

  private async assertThreadInWorkspace(workspaceId: string, threadId: string): Promise<void> {
    const [thread] = await this.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(
        eq(schema.threads.id, threadId),
        eq(schema.threads.workspaceId, workspaceId),
        isNull(schema.threads.deletedAt),
      ))
      .limit(1);
    if (!thread) throw new Error('runtime approval thread/workspace mismatch');
  }

  async decideRuntimeApproval(input: {
    readonly approvalId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly requestedByUserId: string;
    readonly runId: string;
    readonly choice: RuntimeApprovalChoice;
  }): Promise<RuntimeApprovalDecisionResult> {
    const [approval] = await this.db
      .select({
        id: schema.approvalRequests.id,
        requestedByUserId: schema.approvalRequests.requestedByUserId,
        status: schema.approvalRequests.status,
        expiresAt: schema.approvalRequests.expiresAt,
        payload: schema.approvalRequests.payload,
      })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, input.approvalId), eq(schema.approvalRequests.workspaceId, input.workspaceId)))
      .limit(1);

    if (!approval) return { ok: false, reason: 'not_found' };
    const payload = approvalPayload(approval.payload);
    if (
      !payload ||
      approval.requestedByUserId !== input.requestedByUserId ||
      payload.runId !== input.runId ||
      payload.threadId !== input.threadId
    ) {
      return { ok: false, reason: 'mismatch' };
    }
    if (approval.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
      await this.db.update(schema.approvalRequests)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(schema.approvalRequests.id, input.approvalId), eq(schema.approvalRequests.status, 'pending')));
      return { ok: false, reason: 'expired' };
    }

    const [updated] = await this.db.update(schema.approvalRequests)
      .set({
        status: input.choice === 'deny' ? 'rejected' : 'approved',
        decidedByUserId: input.requestedByUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.approvalRequests.id, input.approvalId), eq(schema.approvalRequests.status, 'pending')))
      .returning({ id: schema.approvalRequests.id });

    return updated ? { ok: true } : { ok: false, reason: 'not_pending' };
  }
}
