import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ChatStreamController } from '../src/chat/chat-stream.controller.js';
import { RuntimeApprovalStore, runtimeApprovalActionHash } from '../src/chat/runtime-approval.store.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000002';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000003';
const PROJECT_ID = '00000000-0000-4000-8000-000000000004';
const USER_ID = '00000000-0000-4000-8000-000000000005';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';

function makeController(overrides: {
  decision?: { ok: true } | { ok: false; reason: 'not_found' | 'not_pending' | 'expired' | 'mismatch' };
  access?: { status: 'allowed'; workspaceId: string; projectId: string } | { status: 'forbidden' | 'not_found' };
  respondError?: Error;
} = {}) {
  const resolveAccess = async () => overrides.access ?? ({ status: 'allowed' as const, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID });
  const usecase = {
    canReadThread: vi.fn(resolveAccess),
    canSendThread: vi.fn(resolveAccess),
  };
  const hermes = {
    respondApproval: vi.fn(async (_runId: string, choice: 'once' | 'session' | 'deny') => {
      if (overrides.respondError) throw overrides.respondError;
      return { ok: true, runId: 'run_1', status: choice === 'deny' ? 'denied' : 'approved' };
    }),
  };
  const approvals = {
    decideRuntimeApproval: vi.fn(async () => overrides.decision ?? { ok: true }),
    createRuntimeApproval: vi.fn(),
    markRuntimeApprovalDelivery: vi.fn(async () => undefined),
  };
  const controller = new ChatStreamController(
    usecase as any,
    hermes as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    approvals as any,
    {} as any,
  );
  return { controller, usecase, hermes, approvals };
}

describe('runtime approval ledger gate', () => {
  it('redacts persisted high-blast payloads and removes session approval', async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: THREAD_ID }] }) }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => {
        inserted = value;
        return { returning: async () => [{ id: APPROVAL_ID }] };
      } }),
    };
    const store = new RuntimeApprovalStore(db as never);
    const command = 'mcp-github publish 010-1234-5678 api_key=sk-abcdefghijklmnop';
    const input = {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      runId: 'run_1',
      command,
      message: '담당자 owner@example.com',
      risk: 'low',
      choices: ['once', 'session', 'deny'],
      toolId: 'mcp.github',
    } as const;

    await expect(store.createRuntimeApproval(input)).resolves.toEqual({
      approvalId: APPROVAL_ID,
      actionHash: runtimeApprovalActionHash(input),
    });
    expect(runtimeApprovalActionHash({ ...input, toolId: 'file' }))
      .not.toBe(runtimeApprovalActionHash(input));
    const payload = inserted?.payload as Record<string, unknown>;
    expect(inserted?.riskLevel).toBe('high');
    expect(payload.highBlast).toBe(true);
    expect(payload.toolId).toBe('mcp.github');
    expect(payload.actionBound).toBe(false);
    expect(payload.choices).toEqual(['deny']);
    expect(payload.command).toContain('[REDACTED_PHONE]');
    expect(payload.command).toContain('[REDACTED]');
    expect(payload.message).toBe('담당자 [REDACTED_EMAIL]');
    expect(JSON.stringify(inserted)).not.toContain('010-1234-5678');
    expect(JSON.stringify(inserted)).not.toContain('owner@example.com');
  });

  it('rejects a non-head approval id before resolving Hermes FIFO', async () => {
    const payload = {
      kind: 'hermes_runtime_approval', version: 1, runId: 'run_1', threadId: THREAD_ID,
      actionHash: 'a'.repeat(64), toolId: 'file', upstreamApprovalId: 'upstream-1', command: null, message: null,
      risk: 'high', highBlast: true, choices: ['once', 'deny'],
      actionBound: true, requestedAt: new Date().toISOString(), deliveryStatus: 'pending_user',
    };
    let selectCall = 0;
    const limit = async () => selectCall++ === 0
      ? [{ id: APPROVAL_ID, requestedByUserId: USER_ID, status: 'pending', expiresAt: null, payload }]
      : [{ id: '00000000-0000-4000-8000-000000000099' }];
    const query = { limit, orderBy: () => ({ limit }) };
    const db = {
      select: () => ({ from: () => ({ where: () => query }) }),
      update: vi.fn(),
    };
    const store = new RuntimeApprovalStore(db as never);

    await expect(store.decideRuntimeApproval({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      runId: 'run_1',
      choice: 'once',
    })).resolves.toEqual({ ok: false, reason: 'mismatch' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('requires a product approval ledger id before forwarding upstream approval', async () => {
    const { controller, hermes, approvals } = makeController();

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, choice: 'deny' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(approvals.decideRuntimeApproval).not.toHaveBeenCalled();
    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('rejects positive approval before reading or forwarding the local ledger', async () => {
    const { controller, hermes, approvals } = makeController();

    await expect(controller.approveRuntimeRun(
      'run_1',
      { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'once' },
      { authUserId: USER_ID } as any,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(approvals.decideRuntimeApproval).not.toHaveBeenCalled();
    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('decides the matching pending deny before forwarding it to Hermes', async () => {
    const { controller, hermes, approvals } = makeController();

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'deny' }, { authUserId: USER_ID } as any))
      .resolves.toEqual({ ok: true, runId: 'run_1', status: 'denied' });

    expect(approvals.decideRuntimeApproval).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      runId: 'run_1',
      choice: 'deny',
    });
    expect(hermes.respondApproval).toHaveBeenCalledWith('run_1', 'deny', undefined);
    expect(approvals.markRuntimeApprovalDelivery).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: 'run_1',
      status: 'delivered',
    });
  });

  it('records an ambiguous deny delivery instead of treating an upstream 5xx as delivered', async () => {
    const { controller, approvals } = makeController({ respondError: new Error('Hermes approval failed (503)') });

    await expect(controller.approveRuntimeRun(
      'run_1',
      { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'deny' },
      { authUserId: USER_ID } as any,
    )).rejects.toThrow('Hermes approval failed');

    expect(approvals.markRuntimeApprovalDelivery).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: 'run_1',
      status: 'ambiguous',
    });
  });

  it('does not call upstream Hermes when the ledger row is missing or mismatched', async () => {
    const { controller, hermes } = makeController({ decision: { ok: false, reason: 'mismatch' } });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'deny' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('returns not-found without upstream forwarding for unknown approval ids', async () => {
    const { controller, hermes } = makeController({ decision: { ok: false, reason: 'not_found' } });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'deny' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('scopes approval lookup to the workspace resolved from the thread before upstream forwarding', async () => {
    const { controller, hermes, approvals } = makeController({
      access: { status: 'allowed', workspaceId: OTHER_WORKSPACE_ID, projectId: PROJECT_ID },
      decision: { ok: false, reason: 'not_found' },
    });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'deny' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(approvals.decideRuntimeApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: APPROVAL_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      runId: 'run_1',
    }));
    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });
});
