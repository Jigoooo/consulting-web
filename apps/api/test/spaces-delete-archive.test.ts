import { describe, expect, it, vi } from 'vitest';
import { SpacesController } from '../src/spaces/spaces.controller.js';
import { RestoreParentNotActiveError } from '../src/spaces/space-mutate.service.js';

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';

function makeController() {
  const access = { workspaceMember: vi.fn().mockResolvedValue({ allowed: true }) };
  const reads = {
    listArchivedScopes: vi.fn().mockResolvedValue({
      items: [
        {
          kind: 'channel',
          id: CHANNEL_ID,
          name: '보관된 채널',
          parentPath: ['프로젝트'],
          archivedAt: '2026-07-06T16:00:00.000Z',
        },
      ],
    }),
  };
  const mutate = {
    nodeWorkspace: vi.fn().mockResolvedValue('ws-1'),
    threadWorkspace: vi.fn().mockResolvedValue('ws-1'),
    archiveNode: vi.fn().mockResolvedValue(undefined),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    restoreNode: vi.fn().mockResolvedValue(undefined),
    restoreThread: vi.fn().mockResolvedValue(undefined),
    softDeleteNode: vi.fn().mockResolvedValue(undefined),
    softDeleteThread: vi.fn().mockResolvedValue(undefined),
  };
  const contextGraph = {
    createManualEdge: vi.fn(),
    traverseRelatedScopes: vi.fn().mockResolvedValue([]),
  };
  const controller = new SpacesController(
    access as any,
    reads as any,
    mutate as any,
    contextGraph as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, reads, mutate };
}

describe('SpacesController lifecycle policy', () => {
  it('maps user-facing project DELETE to archive, not deleted_soft', async () => {
    const { controller, mutate } = makeController();

    await controller.deleteProject('project-1', { authUserId: 'user-1' } as any);

    expect(mutate.archiveNode).toHaveBeenCalledWith('project', 'project-1');
    expect(mutate.softDeleteNode).not.toHaveBeenCalled();
  });

  it('maps user-facing channel DELETE to archive, not deleted_soft', async () => {
    const { controller, mutate } = makeController();

    await controller.deleteChannel('channel-1', { authUserId: 'user-1' } as any);

    expect(mutate.archiveNode).toHaveBeenCalledWith('channel', 'channel-1');
    expect(mutate.softDeleteNode).not.toHaveBeenCalled();
  });

  it('maps user-facing topic DELETE to archive, not deleted_soft', async () => {
    const { controller, mutate } = makeController();

    await controller.deleteTopic('topic-1', { authUserId: 'user-1' } as any);

    expect(mutate.archiveNode).toHaveBeenCalledWith('topic', 'topic-1');
    expect(mutate.softDeleteNode).not.toHaveBeenCalled();
  });

  it('maps user-facing thread DELETE to archive, not deleted_soft', async () => {
    const { controller, mutate } = makeController();

    await controller.deleteThread('thread-1', { authUserId: 'user-1' } as any);

    expect(mutate.archiveThread).toHaveBeenCalledWith('thread-1');
    expect(mutate.softDeleteThread).not.toHaveBeenCalled();
  });

  it('lists archived scopes for an accessible workspace', async () => {
    const { controller, reads } = makeController();

    const result = await controller.archive('ws-1', { authUserId: 'user-1' } as any);

    expect(reads.listArchivedScopes).toHaveBeenCalledWith('ws-1');
    expect(result.items[0]?.kind).toBe('channel');
    expect(result.items[0]?.parentPath).toEqual(['프로젝트']);
  });

  it('restores an archived channel through the archive endpoint', async () => {
    const { controller, mutate } = makeController();

    await controller.restoreArchived('channel', CHANNEL_ID, { authUserId: 'user-1' } as any);

    expect(mutate.restoreNode).toHaveBeenCalledWith('channel', CHANNEL_ID);
  });

  it('restores an archived thread through the archive endpoint', async () => {
    const { controller, mutate } = makeController();

    await controller.restoreArchived('thread', THREAD_ID, { authUserId: 'user-1' } as any);

    expect(mutate.restoreThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it('turns parent-archived restore failures into a conflict response', async () => {
    const { controller, mutate } = makeController();
    mutate.restoreNode.mockRejectedValueOnce(new RestoreParentNotActiveError());

    await expect(controller.restoreArchived('channel', CHANNEL_ID, { authUserId: 'user-1' } as any)).rejects.toMatchObject({
      response: { code: 'PARENT_ARCHIVED' },
    });
  });
});
