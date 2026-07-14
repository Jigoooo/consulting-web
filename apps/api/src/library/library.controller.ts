import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ListLibrarySourcesResponseSchema, type LibrarySourceType } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseResponse } from '../http/contract-adapter.js';
import { SpaceAccessService } from '../spaces/space-access.service.js';
import { LibraryStore } from './library.store.js';

const VALID_TYPES = new Set<LibrarySourceType>(['gbrain', 'web', 'file', 'tool', 'manual', 'document', 'artifact']);

/**
 * 자료실(축4) — 워크스페이스/프로젝트 단위 자료 집계 read API.
 * 스키마 변경 0(기존 테이블 조인). 멤버십으로 테넌시 검증.
 */
@Controller('library')
@UseGuards(AccessTokenGuard)
export class LibraryController {
  constructor(
    @Inject(LibraryStore) private readonly store: LibraryStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
  ) {}

  @Get('workspaces/:workspaceId/sources')
  async sources(
    @Param('workspaceId') workspaceId: string,
    @Query('projectId') projectId: string | undefined,
    @Query('type') type: string | undefined,
    @Query('q') q: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    // 프로젝트 필터가 있으면 프로젝트 멤버십, 없으면 워크스페이스 멤버십.
    const access = projectId
      ? await this.access.projectMember(userId, projectId)
      : await this.access.workspaceMember(userId, workspaceId);
    if (!access.allowed) {
      if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'workspace not found' });
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'access denied' });
    }
    // URL workspace is part of the tenant boundary, not a cosmetic path. A
    // readable project from another workspace must not silently replace it.
    if (access.workspaceId !== workspaceId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'workspace or project not found' });
    }
    const typeFilter = type && VALID_TYPES.has(type as LibrarySourceType) ? (type as LibrarySourceType) : undefined;
    const result = await this.store.list({
      workspaceId: access.workspaceId,
      ...(projectId ? { projectId } : {}),
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(q && q.trim() ? { q: q.trim() } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return parseResponse(ListLibrarySourcesResponseSchema, result);
  }
}
