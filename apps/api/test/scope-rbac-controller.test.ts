import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { SpacesController } from '../src/spaces/spaces.controller.js';
import { ChatStreamController } from '../src/chat/chat-stream.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_ID = '44444444-4444-4444-8444-444444444444';

function spacesController(
  access: Record<string, unknown>,
  mutate: Record<string, unknown>,
  createChannel: Record<string, unknown>,
  reads: Record<string, unknown> = {},
) {
  return new (SpacesController as any)(
    access,
    reads,
    mutate,
    {},
    {},
    {},
    {},
    createChannel,
    {},
    {},
    {},
  ) as SpacesController;
}

describe('controller RBAC enforcement', () => {
  it('opts into effective permissions for the workspace tree wire', async () => {
    const access = { workspaceAnyMembership: vi.fn(async () => ({ allowed: true, workspaceId: WORKSPACE_ID })) };
    const reads = { workspaceTree: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, permissions: ['workspace.read'], projects: [] })) };
    const controller = spacesController(access, {}, {}, reads);

    const result = await controller.tree(WORKSPACE_ID, 'true', { authUserId: USER_ID } as never);

    expect(reads.workspaceTree).toHaveBeenCalledWith(WORKSPACE_ID, USER_ID, true);
    expect(result.permissions).toEqual(['workspace.read']);
  });

  it('denies channel creation when the project member lacks channel.create', async () => {
    const access = {
      projectMember: vi.fn(async () => ({ allowed: true, workspaceId: WORKSPACE_ID })),
      projectPermission: vi.fn(async () => ({ allowed: false, reason: 'forbidden' })),
    };
    const createChannel = { commit: vi.fn() };
    const controller = spacesController(access, {}, createChannel);

    await expect(controller.channel(
      { projectId: PROJECT_ID, name: 'Viewer Channel', slug: 'viewer-channel' },
      { authUserId: USER_ID } as never,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.projectPermission).toHaveBeenCalledWith(USER_ID, PROJECT_ID, 'channel.create');
    expect(createChannel.commit).not.toHaveBeenCalled();
  });

  it('denies project rename when the project member lacks project.update', async () => {
    const access = {
      workspaceMember: vi.fn(async () => ({ allowed: true, workspaceId: WORKSPACE_ID })),
      projectPermission: vi.fn(async () => ({ allowed: false, reason: 'forbidden' })),
    };
    const mutate = { nodeWorkspace: vi.fn(async () => WORKSPACE_ID), renameNode: vi.fn() };
    const controller = spacesController(access, mutate, {});

    await expect(controller.renameProject(
      PROJECT_ID,
      { name: 'Viewer Rename' },
      { authUserId: USER_ID } as never,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.projectPermission).toHaveBeenCalledWith(USER_ID, PROJECT_ID, 'project.update');
    expect(mutate.renameNode).not.toHaveBeenCalled();
  });

  it('denies starting a chat stream when the user can read but cannot send', async () => {
    const usecase = {
      canReadThread: vi.fn(async () => ({ status: 'allowed', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })),
      canSendThread: vi.fn(async () => ({ status: 'forbidden' })),
    };
    const hermes = { streamChat: vi.fn() };
    const settlements = { beginCapture: vi.fn() };
    const controller = new (ChatStreamController as any)(
      usecase,
      hermes,
      {},
      {},
      {},
      {},
      {},
      {},
      settlements,
    ) as ChatStreamController;

    await expect(controller.stream(
      { threadId: THREAD_ID, message: 'viewer write attempt', clientMessageId: '55555555-5555-4555-8555-555555555555' },
      { authUserId: USER_ID } as never,
      {} as never,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(usecase.canSendThread).toHaveBeenCalledWith(USER_ID, THREAD_ID);
    expect(settlements.beginCapture).not.toHaveBeenCalled();
    expect(hermes.streamChat).not.toHaveBeenCalled();
  });
});
