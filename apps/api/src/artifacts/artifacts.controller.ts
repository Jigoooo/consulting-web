import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq } from 'drizzle-orm';
import {
  AddArtifactVersionRequestSchema,
  ArtifactDetailResponseSchema,
  CreateArtifactRequestSchema,
  CreateArtifactResponseSchema,
  ListArtifactsResponseSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { SpaceAccessService, type SpaceAccess } from '../spaces/space-access.service.js';
import { NotificationStore } from '../chat/notification.store.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ArtifactStore } from './artifact.store.js';

/** Roles allowed to write artifacts. viewer/commenter are read-only. */
const WRITE_ROLES = new Set(['owner', 'admin', 'editor']);

@Controller('artifacts')
@UseGuards(AccessTokenGuard)
export class ArtifactsController {
  constructor(
    @Inject(ArtifactStore) private readonly artifacts: ArtifactStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(NotificationStore) private readonly notifications: NotificationStore,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Get('workspaces/:workspaceId')
  async list(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(ListArtifactsResponseSchema, await this.artifacts.listForWorkspace(workspaceId));
  }

  @Get(':id')
  async detail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, owner.workspaceId));
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    return parseResponse(ArtifactDetailResponseSchema, detail);
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateArtifactRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.access.projectMember(userId, cmd.projectId);
    this.throwIfDenied(access);
    await this.requireWriteRole(userId, access.workspaceId);

    const result = await this.artifacts.create({
      workspaceId: access.workspaceId,
      projectId: cmd.projectId,
      title: cmd.title,
      content: cmd.content,
      note: cmd.note ?? '',
      createdByUserId: userId,
      sourceThreadId: cmd.sourceThreadId ?? null,
      sourceMessageId: cmd.sourceMessageId ?? null,
    });
    await this.notifications.notifyWorkspace({
      workspaceId: access.workspaceId,
      excludeUserId: userId,
      type: 'artifact_version',
      title: `산출물 등록: ${cmd.title}`,
      body: cmd.note || 'v1 초판이 등록되었습니다.',
      refType: 'artifact',
      refId: result.id,
    });
    return parseResponse(CreateArtifactResponseSchema, { id: result.id, versionNo: result.versionNo });
  }

  @Post(':id/versions')
  async addVersion(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(AddArtifactVersionRequestSchema, body);
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, owner.workspaceId));
    await this.requireWriteRole(userId, owner.workspaceId);

    const { versionNo } = await this.artifacts.addVersion({
      artifactId: id,
      workspaceId: owner.workspaceId,
      content: cmd.content,
      note: cmd.note ?? '',
      authorUserId: userId,
      sourceThreadId: cmd.sourceThreadId ?? null,
      sourceMessageId: cmd.sourceMessageId ?? null,
    });
    await this.notifications.notifyWorkspace({
      workspaceId: owner.workspaceId,
      excludeUserId: userId,
      type: 'artifact_version',
      title: `산출물 갱신 (v${versionNo})`,
      body: cmd.note || `새 버전 v${versionNo}이 추가되었습니다.`,
      refType: 'artifact',
      refId: id,
    });
    return parseResponse(CreateArtifactResponseSchema, { id, versionNo });
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, owner.workspaceId));
    await this.requireWriteRole(userId, owner.workspaceId);
    await this.artifacts.softDelete(id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  /** Editor+ required for writes (A-2 role gate). */
  private async requireWriteRole(userId: string, workspaceId: string): Promise<void> {
    const rows = await this.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)));
    if (!rows.some((r) => WRITE_ROLES.has(r.role))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'write access requires editor role or above' });
    }
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}
