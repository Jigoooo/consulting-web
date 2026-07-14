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
  Optional,
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
  AddArtifactVersionV1RequestSchema,
  ArtifactContractCapabilitiesResponseSchema,
  ArtifactBatchReviewPlanResponseSchema,
  ArtifactDetailResponseSchema,
  ArtifactDetailV1ResponseSchema,
  ArtifactExportPreflightResponseSchema,
  ArtifactExportPreflightV1ResponseSchema,
  ArtifactReviewDecisionRequestSchema,
  ArtifactReviewDecisionResponseSchema,
  CreateArtifactRequestSchema,
  CreateArtifactV1RequestSchema,
  CreateArtifactResponseSchema,
  ListArtifactsResponseSchema,
  OkResponseSchema,
  VerifyArtifactVersionRequestSchema,
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
import { ArtifactVerificationService } from './artifact-verification.service.js';
import { ArtifactHumanReviewService } from './artifact-human-review.service.js';
import { artifactHumanReviewStatus } from './artifact-human-review-policy.js';
import { artifactContentHash } from './artifact-export-preflight-audit.js';
import { ReportWorkflowShadowService } from '../workflows/report-workflow-shadow.service.js';

type ArtifactOwnerRef = { workspaceId: string; projectId: string };
type ArtifactExportVersionRef = {
  id: string;
  versionNo: number;
  content: string;
  governingMessage: string | null;
  soWhat: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
};

const REPORT_WORKFLOW_SHADOW_DEADLINE_MS = 250;

@Controller('artifacts')
@UseGuards(AccessTokenGuard)
export class ArtifactsController {
  constructor(
    @Inject(ArtifactStore) private readonly artifacts: ArtifactStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(NotificationStore) private readonly notifications: NotificationStore,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ArtifactExportService) private readonly exporter: ArtifactExportService,
    @Inject(ArtifactVerificationService) private readonly artifactVerification: ArtifactVerificationService,
    @Inject(ArtifactHumanReviewService) private readonly humanReview: ArtifactHumanReviewService,
    @Optional() @Inject(ReportWorkflowShadowService) private readonly reportWorkflow: ReportWorkflowShadowService | undefined = undefined,
  ) {}

  @Get('workspaces/:workspaceId')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('projectId') projectId: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Query('offset') offsetRaw?: string,
  ) {
    const userId = requireAuthUserId(req);
    let projectIds: string[];
    if (projectId) {
      await this.requireProjectAccess(userId, projectId, 'artifact.render', workspaceId);
      projectIds = [projectId];
    } else {
      const membership = await this.access.workspaceAnyMembership(userId, workspaceId);
      if (!membership.allowed) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'workspace not found' });
      }
      projectIds = await this.access.permittedProjectIds(userId, workspaceId, 'artifact.render');
    }
    return parseResponse(
      ListArtifactsResponseSchema,
      await this.artifacts.listForWorkspace(workspaceId, projectIds, parseReviewPlanOffset(offsetRaw)),
    );
  }

  @Get('projects/:projectId/review-plan')
  async reviewPlan(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
    @Query('offset') offsetRaw?: string,
  ) {
    const userId = requireAuthUserId(req);
    await this.requireProjectAccess(userId, projectId, 'artifact.render');
    return parseResponse(ArtifactBatchReviewPlanResponseSchema, await this.humanReview.projectPlan(projectId, parseReviewPlanOffset(offsetRaw)));
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Query('includeStructure') includeStructure?: string,
  ) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.render');
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    if (includeStructure === '1') return parseResponse(ArtifactDetailResponseSchema, detail);
    return parseResponse(ArtifactDetailV1ResponseSchema, toArtifactDetailV1(detail));
  }

  @Get(':id/export-preflight')
  async exportPreflight(
    @Param('id') id: string,
    @Query('format') formatRaw: string | undefined,
    @Query('version') versionRaw: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Query('includeReview') includeReview?: string,
  ) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.render');
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });

    parseExportFormat(formatRaw);
    const versionNo = versionRaw ? Number(versionRaw) : detail.headVersion;
    if (!Number.isInteger(versionNo) || versionNo <= 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'invalid artifact version' });
    }
    const version = detail.versions.find((v) => v.versionNo === versionNo);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });

    const eligibility = await this.evaluateExportEligibility(owner, detail.id, detail.title, version);
    if (includeReview === '1') return parseResponse(ArtifactExportPreflightResponseSchema, eligibility.response);
    return parseResponse(ArtifactExportPreflightV1ResponseSchema, toArtifactPreflightV1(eligibility.response));
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
    await this.requireArtifactAccess(userId, owner, 'artifact.render');
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });

    const format = parseExportFormat(formatRaw);
    const versionNo = versionRaw ? Number(versionRaw) : detail.headVersion;
    if (!Number.isInteger(versionNo) || versionNo <= 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'invalid artifact version' });
    }
    const version = detail.versions.find((v) => v.versionNo === versionNo);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });

    const eligibility = await this.evaluateExportEligibility(owner, detail.id, detail.title, version);
    const preflight = eligibility.response;
    if (!preflight.canExport || !version.governingMessage || !version.soWhat) {
      throw new ConflictException({
        code: 'VERIFIER_GATE_BLOCKED',
        message: preflight.reason === 'HUMAN_REVIEW_REQUIRED'
          ? '현재 버전은 사람 검토 승인 후 내보낼 수 있습니다.'
          : preflight.reason === 'HUMAN_REVIEW_REJECTED'
            ? '현재 버전은 사람 검토에서 반려되어 내보낼 수 없습니다.'
            : '검증 게이트가 이 산출물의 내보내기를 차단했습니다. 핵심 주장의 근거를 보강한 뒤 다시 시도하세요.',
        reason: preflight.reason,
        gate: preflight.gate,
        messages: preflight.messages,
      });
    }

    const exported = await this.exporter.export({
      title: detail.title,
      versionNo: version.versionNo,
      content: version.content,
      governingMessage: version.governingMessage,
      soWhat: version.soWhat,
      format,
    });
    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Length', String(exported.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeRFC5987(exported.fileName)}`);
    res.end(exported.buffer);
  }

  @Post(':id/verify')
  async verifyArtifact(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Query('includeReview') includeReview?: string,
  ) {
    const cmd = parseBody(VerifyArtifactVersionRequestSchema, body);
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.create');
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    const versionNo = cmd.versionNo ?? detail.headVersion;
    const version = detail.versions.find((item) => item.versionNo === versionNo);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });

    await this.artifactVerification.verifyVersion({
      artifactId: detail.id,
      artifactVersionId: version.id,
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      title: detail.title,
      versionNo: version.versionNo,
      content: version.content,
      governingMessage: version.governingMessage,
      soWhat: version.soWhat,
      sourceThreadId: version.sourceThreadId,
      sourceMessageId: version.sourceMessageId,
      verifiedByUserId: userId,
    });
    const eligibility = await this.evaluateExportEligibility(owner, detail.id, detail.title, version);
    if (includeReview === '1') return parseResponse(ArtifactExportPreflightResponseSchema, eligibility.response);
    return parseResponse(ArtifactExportPreflightV1ResponseSchema, toArtifactPreflightV1(eligibility.response));
  }

  @Post(':id/versions/:versionNo/review-decision')
  async reviewDecision(
    @Param('id') id: string,
    @Param('versionNo') versionNoRaw: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const cmd = parseBody(ArtifactReviewDecisionRequestSchema, body);
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.create');
    const detail = await this.artifacts.detail(id);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    const versionNo = Number(versionNoRaw);
    const version = detail.versions.find((item) => item.versionNo === versionNo);
    if (!Number.isInteger(versionNo) || !version) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact version not found' });
    }
    const target = artifactVerificationTarget(owner, detail.id, detail.title, version);
    const before = await this.evaluateExportEligibility(owner, detail.id, detail.title, version);
    const result = await this.humanReview.recordDecision({
      target,
      preflight: before.verifier,
      action: cmd.action,
      note: cmd.note ?? '',
      decidedByUserId: userId,
    });
    if (!result.ok) {
      throw new ConflictException({
        code: 'HUMAN_REVIEW_DECISION_NOT_ALLOWED',
        message: '사람 승인은 검증 또는 적대 검토의 하드 차단을 우회할 수 없습니다.',
        reason: result.reason,
      });
    }
    const after = await this.evaluateExportEligibility(owner, detail.id, detail.title, version);
    await this.settleShadow(() => this.reportWorkflow!.resume(
      reportWorkflowTarget(after.target),
      after.verifier,
      after.response.canExport,
      after.response.canExport,
      after.response.reason,
    ));
    return parseResponse(ArtifactReviewDecisionResponseSchema, { decision: result.decision });
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Query('includeStructure') includeStructure?: string,
  ) {
    const cmd = includeStructure === '1'
      ? parseBody(CreateArtifactRequestSchema, body)
      : { ...parseBody(CreateArtifactV1RequestSchema, body), structure: undefined };
    const structure = cmd.structure;
    const userId = requireAuthUserId(req);
    const access = await this.requireProjectAccess(userId, cmd.projectId, 'artifact.create');
    const source = await this.validateArtifactSource(access.workspaceId, cmd.projectId, cmd.sourceThreadId ?? null, cmd.sourceMessageId ?? null);

    const result = await this.db.transaction(async (tx) => {
      const created = await this.artifacts.create({
        workspaceId: access.workspaceId,
        projectId: cmd.projectId,
        title: cmd.title,
        content: cmd.content,
        governingMessage: structure?.governingMessage ?? null,
        soWhat: structure?.soWhat ?? null,
        note: cmd.note ?? '',
        createdByUserId: userId,
        sourceThreadId: source.sourceThreadId,
        sourceMessageId: source.sourceMessageId,
      }, tx);
      await this.notifications.notifyWorkspace({
        workspaceId: access.workspaceId,
        excludeUserId: userId,
        dedupKey: `artifact:${created.id}:version:1`,
        type: 'artifact_version',
        title: `산출물 등록: ${cmd.title}`,
        body: cmd.note || 'v1 초판이 등록되었습니다.',
        refType: 'artifact',
        refId: created.id,
      }, tx);
      return created;
    });
    return parseResponse(CreateArtifactResponseSchema, { id: result.id, versionNo: result.versionNo });
  }

  @Post(':id/versions')
  async addVersion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Query('includeStructure') includeStructure?: string,
  ) {
    const cmd = includeStructure === '1'
      ? parseBody(AddArtifactVersionRequestSchema, body)
      : { ...parseBody(AddArtifactVersionV1RequestSchema, body), structure: undefined };
    const structure = cmd.structure;
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.create');
    const source = await this.validateArtifactSource(owner.workspaceId, owner.projectId, cmd.sourceThreadId ?? null, cmd.sourceMessageId ?? null);

    const { versionNo } = await this.db.transaction(async (tx) => {
      const result = await this.artifacts.addVersion({
        artifactId: id,
        workspaceId: owner.workspaceId,
        content: cmd.content,
        governingMessage: structure?.governingMessage ?? null,
        soWhat: structure?.soWhat ?? null,
        note: cmd.note ?? '',
        authorUserId: userId,
        sourceThreadId: source.sourceThreadId,
        sourceMessageId: source.sourceMessageId,
      }, tx);
      await this.notifications.notifyWorkspace({
        workspaceId: owner.workspaceId,
        excludeUserId: userId,
        dedupKey: `artifact:${id}:version:${result.versionNo}`,
        type: 'artifact_version',
        title: `산출물 갱신 (v${result.versionNo})`,
        body: cmd.note || `새 버전 v${result.versionNo}이 추가되었습니다.`,
        refType: 'artifact',
        refId: id,
      }, tx);
      return result;
    });
    return parseResponse(CreateArtifactResponseSchema, { id, versionNo });
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const owner = await this.artifacts.artifactWorkspace(id);
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'artifact not found' });
    await this.requireArtifactAccess(userId, owner, 'artifact.create');
    await this.artifacts.softDelete(id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  private async evaluateExportEligibility(
    owner: ArtifactOwnerRef,
    artifactId: string,
    title: string,
    version: ArtifactExportVersionRef,
  ): Promise<{
    target: ReturnType<typeof artifactVerificationTarget>;
    verifier: ArtifactExportPreflightResponse;
    response: ArtifactExportPreflightResponse;
  }> {
    const target = artifactVerificationTarget(owner, artifactId, title, version);
    const verifier = await this.artifactVerification.preflightVersion(target);
    const human = await this.humanReview.exportDecision(target, verifier);
    const structureReady = Boolean(version.governingMessage) && Boolean(version.soWhat);
    const finalCanExport = verifier.canExport && human.canExport && structureReady;
    const response: ArtifactExportPreflightResponse = {
      ...verifier,
      canExport: finalCanExport,
      reason: finalCanExport
        ? 'OK'
        : !verifier.canExport
          ? human.reason
          : structureReady
            ? human.reason
            : 'ARTIFACT_STRUCTURE_REQUIRED',
      humanReview: {
        status: artifactHumanReviewStatus(verifier, human),
        reason: human.reason,
      },
    };
    await this.settleShadow(() => this.reportWorkflow!.observe(
      reportWorkflowTarget(target),
      verifier,
      finalCanExport,
      response.reason,
    ));
    return { target, verifier, response };
  }

  private async settleShadow(operation: () => Promise<unknown>): Promise<void> {
    if (!this.reportWorkflow) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REPORT_WORKFLOW_SHADOW_DEADLINE_MS);
      Promise.resolve().then(operation).then(
        () => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); resolve(); },
      );
    });
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

  private async requireArtifactAccess(
    userId: string,
    owner: ArtifactOwnerRef,
    permission: 'artifact.render' | 'artifact.create',
  ): Promise<void> {
    await this.requireProjectAccess(userId, owner.projectId, permission, owner.workspaceId, 'artifact not found');
  }

  private async requireProjectAccess(
    userId: string,
    projectId: string,
    permission: 'artifact.render' | 'artifact.create',
    expectedWorkspaceId?: string,
    notFoundMessage = 'project not found',
  ): Promise<Extract<SpaceAccess, { allowed: true }>> {
    const access = await this.access.projectPermission(userId, projectId, permission);
    if (!access.allowed) {
      if (access.reason === 'not_found') {
        throw new NotFoundException({ code: 'NOT_FOUND', message: notFoundMessage });
      }
      const membership = await this.access.workspaceAnyMembership(userId, access.workspaceId);
      if (!membership.allowed) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: notFoundMessage });
      }
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
    }
    if (expectedWorkspaceId && access.workspaceId !== expectedWorkspaceId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: notFoundMessage });
    }
    return access;
  }
}

@Controller('artifact-contract')
@UseGuards(AccessTokenGuard)
export class ArtifactContractController {
  @Get()
  contractCapabilities() {
    return parseResponse(ArtifactContractCapabilitiesResponseSchema, { version: 2 });
  }
}

function artifactVerificationTarget(
  owner: ArtifactOwnerRef,
  artifactId: string,
  title: string,
  version: ArtifactExportVersionRef,
) {
  return {
    artifactId,
    artifactVersionId: version.id,
    workspaceId: owner.workspaceId,
    projectId: owner.projectId,
    title,
    versionNo: version.versionNo,
    content: version.content,
    governingMessage: version.governingMessage,
    soWhat: version.soWhat,
    sourceThreadId: version.sourceThreadId,
    sourceMessageId: version.sourceMessageId,
  };
}

function reportWorkflowTarget(target: ReturnType<typeof artifactVerificationTarget>) {
  return {
    ...target,
    contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
  };
}

function toArtifactDetailV1(detail: NonNullable<Awaited<ReturnType<ArtifactStore['detail']>>>) {
  return {
    ...detail,
    versions: detail.versions.map(({ governingMessage: _governingMessage, soWhat: _soWhat, ...version }) => version),
  };
}

function toArtifactPreflightV1(preflight: ArtifactExportPreflightResponse) {
  const reason = preflight.reason === 'OK'
    || preflight.reason === 'ARTIFACT_VERIFICATION_REQUIRED'
    || preflight.reason === 'VERIFIER_GATE_BLOCKED'
    ? preflight.reason
    : 'VERIFIER_GATE_BLOCKED';
  return {
    canExport: preflight.canExport,
    reason,
    versionNo: preflight.versionNo,
    gate: preflight.gate,
    messages: preflight.messages,
  };
}

function parseExportFormat(value: string | undefined): ArtifactExportFormat {
  if (value === 'pdf' || value === 'docx') return value;
  throw new BadRequestException({ code: 'VALIDATION', message: 'format must be pdf or docx' });
}

function parseReviewPlanOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (Number.isSafeInteger(offset) && offset >= 0) return offset;
  throw new BadRequestException({ code: 'VALIDATION', message: 'offset must be a non-negative safe integer' });
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, '%2A');
}
