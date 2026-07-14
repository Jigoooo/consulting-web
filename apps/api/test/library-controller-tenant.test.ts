import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/auth/access-token.guard.js';
import { LibraryController } from '../src/library/library.controller.js';
import type { LibraryStore } from '../src/library/library.store.js';
import type { SpaceAccessService } from '../src/spaces/space-access.service.js';

const req = { authUserId: '00000000-0000-4000-8000-000000000001' } as AuthenticatedRequest;

describe('LibraryController tenant path invariant', () => {
  it('rejects a project filter whose canonical workspace differs from the URL workspace', async () => {
    const store = { list: vi.fn() } as unknown as LibraryStore;
    const access = {
      projectMember: vi.fn().mockResolvedValue({
        allowed: true,
        workspaceId: '00000000-0000-4000-8000-00000000000b',
      }),
    } as unknown as SpaceAccessService;
    const controller = new LibraryController(store, access);

    await expect(controller.sources(
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-000000000002',
      undefined,
      undefined,
      undefined,
      req,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('uses the URL workspace only when it matches the project canonical workspace', async () => {
    const workspaceId = '00000000-0000-4000-8000-00000000000a';
    const projectId = '00000000-0000-4000-8000-000000000002';
    const list = vi.fn().mockResolvedValue({ sources: [], nextCursor: null });
    const store = { list } as unknown as LibraryStore;
    const access = {
      projectMember: vi.fn().mockResolvedValue({ allowed: true, workspaceId }),
    } as unknown as SpaceAccessService;
    const controller = new LibraryController(store, access);

    await controller.sources(workspaceId, projectId, undefined, undefined, undefined, req);
    expect(list).toHaveBeenCalledWith({ workspaceId, projectId });
  });
});
