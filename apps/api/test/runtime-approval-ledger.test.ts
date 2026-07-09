import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ChatStreamController } from '../src/chat/chat-stream.controller.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000002';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000003';
const PROJECT_ID = '00000000-0000-4000-8000-000000000004';
const USER_ID = '00000000-0000-4000-8000-000000000005';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';

function makeController(overrides: {
  decision?: { ok: true } | { ok: false; reason: 'not_found' | 'not_pending' | 'expired' | 'mismatch' };
  access?: { status: 'allowed'; workspaceId: string; projectId: string } | { status: 'forbidden' | 'not_found' };
} = {}) {
  const usecase = {
    canReadThread: vi.fn(async () => overrides.access ?? ({ status: 'allowed', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })),
  };
  const hermes = {
    respondApproval: vi.fn(async () => ({ ok: true, runId: 'run_1', status: 'approved' })),
  };
  const approvals = {
    decideRuntimeApproval: vi.fn(async () => overrides.decision ?? { ok: true }),
    createRuntimeApproval: vi.fn(),
  };
  const controller = new ChatStreamController(
    usecase as any,
    hermes as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    approvals as any,
  );
  return { controller, usecase, hermes, approvals };
}

describe('runtime approval ledger gate', () => {
  it('requires a product approval ledger id before forwarding upstream approval', async () => {
    const { controller, hermes, approvals } = makeController();

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, choice: 'once' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(approvals.decideRuntimeApproval).not.toHaveBeenCalled();
    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('decides the matching pending ledger row before forwarding approval to Hermes', async () => {
    const { controller, hermes, approvals } = makeController();

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'once' }, { authUserId: USER_ID } as any))
      .resolves.toEqual({ ok: true, runId: 'run_1', status: 'approved' });

    expect(approvals.decideRuntimeApproval).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestedByUserId: USER_ID,
      runId: 'run_1',
      choice: 'once',
    });
    expect(hermes.respondApproval).toHaveBeenCalledWith('run_1', 'once', undefined);
  });

  it('does not call upstream Hermes when the ledger row is missing or mismatched', async () => {
    const { controller, hermes } = makeController({ decision: { ok: false, reason: 'mismatch' } });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'once' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('returns not-found without upstream forwarding for unknown approval ids', async () => {
    const { controller, hermes } = makeController({ decision: { ok: false, reason: 'not_found' } });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'once' }, { authUserId: USER_ID } as any))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(hermes.respondApproval).not.toHaveBeenCalled();
  });

  it('scopes approval lookup to the workspace resolved from the thread before upstream forwarding', async () => {
    const { controller, hermes, approvals } = makeController({
      access: { status: 'allowed', workspaceId: OTHER_WORKSPACE_ID, projectId: PROJECT_ID },
      decision: { ok: false, reason: 'not_found' },
    });

    await expect(controller.approveRuntimeRun('run_1', { threadId: THREAD_ID, approvalId: APPROVAL_ID, choice: 'once' }, { authUserId: USER_ID } as any))
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
