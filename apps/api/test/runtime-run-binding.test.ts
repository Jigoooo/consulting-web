import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ChatStreamController } from '../src/chat/chat-stream.controller.js';

const USER_ID = '73000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '73000000-0000-4000-8000-000000000002';
const PROJECT_ID = '73000000-0000-4000-8000-000000000003';
const THREAD_A = '73000000-0000-4000-8000-000000000004';
const THREAD_B = '73000000-0000-4000-8000-000000000005';
const RUN_ID = 'run-bound-to-thread-b';

function makeController() {
  const access = { status: 'allowed' as const, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };
  const usecase = {
    canReadThread: vi.fn().mockResolvedValue(access),
    canSendThread: vi.fn().mockResolvedValue(access),
  };
  const hermes = {
    runStatus: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'running' }),
    stopRun: vi.fn().mockResolvedValue({ ok: true, runId: RUN_ID, status: 'stopping' }),
  };
  const settlements = {
    findOwnershipByRunId: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, threadId: THREAD_B }),
  };
  const controller = new ChatStreamController(
    usecase as never,
    hermes as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    settlements as never,
  );
  return { controller, hermes, settlements };
}

describe('runtime run ownership binding', () => {
  it('does not disclose or stop a run through a different readable thread', async () => {
    const { controller, hermes, settlements } = makeController();

    await expect(controller.runtimeRunStatus(RUN_ID, THREAD_A, { authUserId: USER_ID } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.stopRuntimeRun(RUN_ID, { threadId: THREAD_A }, { authUserId: USER_ID } as never)).rejects.toBeInstanceOf(NotFoundException);

    expect(settlements.findOwnershipByRunId).toHaveBeenCalledTimes(2);
    expect(hermes.runStatus).not.toHaveBeenCalled();
    expect(hermes.stopRun).not.toHaveBeenCalled();
  });

  it('forwards runtime actions only when run, thread, and workspace match', async () => {
    const { controller, hermes } = makeController();

    await expect(controller.runtimeRunStatus(RUN_ID, THREAD_B, { authUserId: USER_ID } as never)).resolves.toMatchObject({ runId: RUN_ID });
    await expect(controller.stopRuntimeRun(RUN_ID, { threadId: THREAD_B }, { authUserId: USER_ID } as never)).resolves.toMatchObject({ ok: true });

    expect(hermes.runStatus).toHaveBeenCalledWith(RUN_ID);
    expect(hermes.stopRun).toHaveBeenCalledWith(RUN_ID);
  });
});
