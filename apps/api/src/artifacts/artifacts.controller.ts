import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  AddArtifactVersionRequestSchema,
  ArtifactDetailResponseSchema,
  ArtifactExportPreflightResponseSchema,
  CreateArtifactRequestSchema,
  CreateArtifactResponseSchema,
  ListArtifactsResponseSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { SpaceAccessService, type SpaceAccess } from '../spaces/space-access.service.js';
import { NotificationStore } from '../chat/notification.store.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import type { Response } from 'express';
import { ArtifactStore } from './artifact.store.js';
import { ArtifactExportService, type ArtifactExportFormat } from './artifact-export.service.js';
import { EvidenceDecisionStore } from '../consulting/evidence-decision.store.js';

/** Roles allowed to write artifacts. viewer/commenter are read-only. */
const WRITE_ROLES = new Set(['owner', 'admin', 'editor']);

type ArtifactOwnerRef = { workspaceId: string; projectId: string };
type ArtifactExportVersionRef = { versionNo: number; sourceThreadId: string | null; sourceMessageId: string | null };

@Controller('artifacts')
@UseGuards(AccessTokenGuard)
export class ArtifactsController {
  constructor(
    @Inject(ArtifactStore) private readonly artifacts: ArtifactStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(NotificationStore) private readonly notifications: NotificationStore,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ArtifactExportService) private readonly exporter: ArtifactExportService,
    @Inject(EvidenceDecisionStore) private readonly gateStore: EvidenceDecisionStore,
  ) {}

  @Get('workspaces/:workspaceId')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('projectId') projectId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(
      ListArtifactsResponseSchema,
      await this.artifacts.listForWorkspace(workspaceId, projectId || undefined),
    );
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

  @Get(':id/export-preflight')
  async exportPreflight(
    @Param('id') id: string,
    @Query('format') formatRaw: string | undefined,
    @Query('version') versionRaw: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, owner.workspaceId));
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });

    parseExportFormat(formatRaw);
    const versionNo = versionRaw ? Number(versionRaw) : detail.headVersion;
    if (!Number.isInteger(versionNo) || versionNo <= 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'invalid artifact version' });
    }
    const version = detail.versions.find((v) => v.versionNo === versionNo);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });

    return parseResponse(ArtifactExportPreflightResponseSchema, await this.preflightExport(owner, version));
  }

  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Query('format') formatRaw: string | undefined,
    @Query('version') versionRaw: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, owner.workspaceId));
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });

    const format = parseExportFormat(formatRaw);
    const versionNo = versionRaw ? Number(versionRaw) : detail.headVersion;
    if (!Number.isInteger(versionNo) || versionNo <= 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'invalid artifact version' });
    }
    const version = detail.versions.find((v) => v.versionNo === versionNo);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });

    const preflight = await this.preflightExport(owner, version);
    if (!preflight.canExport) {
      throw new ConflictException({
        code: 'VERIFIER_GATE_BLOCKED',
        message: '검증 게이트가 이 산출물의 내보내기를 차단했습니다. 핵심 주장의 근거를 보강한 뒤 다시 시도하세요.',
        gate: preflight.gate,
      });
    }

    const exported = await this.exporter.export({
      title: detail.title,
      versionNo: version.versionNo,
      content: version.content,
      format,
    });
    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Length', String(exported.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeRFC5987(exported.fileName)}`);
    res.end(exported.buffer);
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateArtifactRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.access.projectMember(userId, cmd.projectId);
    this.throwIfDenied(access);
    await this.requireWriteRole(userId, access.workspaceId);
    const source = await this.validateArtifactSource(access.workspaceId, cmd.projectId, cmd.sourceThreadId ?? null, cmd.sourceMessageId ?? null);

    const result = await this.artifacts.create({
      workspaceId: access.workspaceId,
      projectId: cmd.projectId,
      title: cmd.title,
      content: cmd.content,
      note: cmd.note ?? '',
      createdByUserId: userId,
      sourceThreadId: source.sourceThreadId,
      sourceMessageId: source.sourceMessageId,
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
    const source = await this.validateArtifactSource(owner.workspaceId, owner.projectId, cmd.sourceThreadId ?? null, cmd.sourceMessageId ?? null);

    const { versionNo } = await this.artifacts.addVersion({
      artifactId: id,
      workspaceId: owner.workspaceId,
      content: cmd.content,
      note: cmd.note ?? '',
      authorUserId: userId,
      sourceThreadId: source.sourceThreadId,
      sourceMessageId: source.sourceMessageId,
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

  private async preflightExport(
    owner: ArtifactOwnerRef,
    version: ArtifactExportVersionRef,
  ): Promise<ArtifactExportPreflightResponse> {
    if (!version.sourceMessageId) {
      return {
        canExport: true,
        reason: 'NO_SOURCE_MESSAGE',
        versionNo: version.versionNo,
        gate: null,
        messages: [
          '이 버전은 원본 답변(sourceMessageId)과 연결되지 않아 문장별 검증 게이트를 확인할 수 없습니다.',
        ],
      };
    }

    const source = await this.validateArtifactSource(owner.workspaceId, owner.projectId, version.sourceThreadId, version.sourceMessageId);
    const gate = await this.gateStore.gateForAssistantMessage({
      assistantMessageId: source.sourceMessageId!,
      workspaceId: owner.workspaceId,
      threadId: source.sourceThreadId,
    });
    const messages = [...gate.blockers, ...gate.warnings].map((issue) => issue.message);
    if (gate.decision === 'BLOCKED') {
      return {
        canExport: false,
        reason: 'VERIFIER_GATE_BLOCKED',
        versionNo: version.versionNo,
        gate,
        messages: messages.length > 0 ? messages : ['검증 게이트가 이 산출물의 내보내기를 차단했습니다.'],
      };
    }
    return {
      canExport: true,
      reason: 'OK',
      versionNo: version.versionNo,
      gate,
      messages,
    };
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

  private async validateArtifactSource(
    workspaceId: string,
    projectId: string,
    sourceThreadId: string | null,
    sourceMessageId: string | null,
  ): Promise<{ sourceThreadId: string | null; sourceMessageId: string | null }> {
    if (!sourceThreadId && !sourceMessageId) return { sourceThreadId: null, sourceMessageId: null };

    if (sourceMessageId) {
      const [row] = await this.db
        .select({
          workspaceId: schema.chatMessages.workspaceId,
          threadId: schema.chatMessages.threadId,
          projectId: schema.channels.projectId,
        })
        .from(schema.chatMessages)
        .innerJoin(schema.threads, eq(schema.chatMessages.threadId, schema.threads.id))
        .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
        .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
        .where(and(
          eq(schema.chatMessages.id, sourceMessageId),
          isNull(schema.chatMessages.deletedAt),
          isNull(schema.threads.deletedAt),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
        ))
        .limit(1);
      if (!row || row.workspaceId !== workspaceId || row.projectId !== projectId) {
        throw new BadRequestException({ code: 'VALIDATION', message: 'artifact source message does not belong to this project' });
      }
      if (sourceThreadId && sourceThreadId !== row.threadId) {
        throw new BadRequestException({ code: 'VALIDATION', message: 'artifact source thread does not match source message' });
      }
      return { sourceThreadId: row.threadId, sourceMessageId };
    }

    const [row] = await this.db
      .select({
        workspaceId: schema.threads.workspaceId,
        threadId: schema.threads.id,
        projectId: schema.channels.projectId,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .where(and(
        eq(schema.threads.id, sourceThreadId!),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
      ))
      .limit(1);
    if (!row || row.workspaceId !== workspaceId || row.projectId !== projectId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'artifact source thread does not belong to this project' });
    }
    return { sourceThreadId: row.threadId, sourceMessageId: null };
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}

function parseExportFormat(value: string | undefined): ArtifactExportFormat {
  if (value === 'pdf' || value === 'docx') return value;
  throw new BadRequestException({ code: 'VALIDATION', message: 'format must be pdf or docx' });
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, '%2A');
}
