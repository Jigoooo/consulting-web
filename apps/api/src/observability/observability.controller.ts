import { BadRequestException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ObservabilityTraceListResponseSchema } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseResponse } from '../http/contract-adapter.js';
import { SpaceAccessService } from '../spaces/space-access.service.js';
import { ObservabilityStore } from './observability.store.js';

@Controller('observability')
@UseGuards(AccessTokenGuard)
export class ObservabilityController {
  constructor(
    @Inject(ObservabilityStore) private readonly store: ObservabilityStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
  ) {}

  @Get('workspaces/:workspaceId/traces')
  async traces(
    @Param('workspaceId') workspaceId: string,
    @Query('threadId') threadId: string | undefined,
    @Query('traceId') traceId: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    const access = await this.access.workspaceMember(userId, workspaceId);
    if (!access.allowed) {
      if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'workspace not found' });
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'access denied' });
    }
    if (threadId) {
      if (!isUuid(threadId)) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: 'invalid threadId' });
      }
      const threadAccess = await this.access.threadMember(userId, threadId);
      if (!threadAccess.allowed) {
        if (threadAccess.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'thread not found' });
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'access denied' });
      }
      if (threadAccess.workspaceId !== workspaceId) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'thread not found in workspace' });
      }
    }
    const limit = parseLimit(limitRaw);
    return parseResponse(ObservabilityTraceListResponseSchema, await this.store.listTraces({
      workspaceId,
      ...(threadId ? { threadId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    }));
  }
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
