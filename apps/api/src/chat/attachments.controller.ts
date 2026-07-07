import {
  BadRequestException,
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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { schema } from '@consulting/db-schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  ListAttachmentsResponseSchema,
  MAX_ATTACHMENT_BYTES,
  UploadAttachmentRequestSchema,
  UploadAttachmentResponseSchema,
  AttachmentExtractionResponseSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { DocumentExtractionWorker } from './document-extraction.worker.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const ALLOWED_MIME_PREFIXES = ['image/', 'text/'];
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/haansofthwp',
  'application/x-hwp',
  'application/vnd.hancom.hwpx',
  'application/hwp+zip',
]);

/** Phase 2-D G-3 — chat attachments (base64 in pg; 10MB cap; mime allowlist). */
@Controller('attachments')
@UseGuards(AccessTokenGuard)
export class AttachmentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ChatStreamUseCase) private readonly chatAccess: ChatStreamUseCase,
    @Inject(DocumentExtractionWorker) private readonly extractionWorker: DocumentExtractionWorker,
  ) {}

  @Post()
  async upload(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(UploadAttachmentRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThread(userId, cmd.threadId);

    if (!ALLOWED_MIME_PREFIXES.some((p) => cmd.mimeType.startsWith(p)) && !ALLOWED_MIME_TYPES.has(cmd.mimeType)) {
      throw new BadRequestException({ code: 'UNSUPPORTED_TYPE', message: '이미지, PDF, 텍스트, HWP/HWPX 파일만 첨부할 수 있어요.' });
    }
    // Validate base64 and enforce the BINARY size cap (schema caps the string).
    let sizeBytes: number;
    try {
      sizeBytes = Buffer.from(cmd.dataBase64, 'base64').length;
    } catch {
      throw new BadRequestException({ code: 'BAD_ENCODING', message: 'invalid base64 payload' });
    }
    if (sizeBytes === 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException({ code: 'TOO_LARGE', message: '파일은 10MB 이하만 첨부할 수 있어요.' });
    }

    const [row] = await this.db
      .insert(schema.fileAttachments)
      .values({
        workspaceId: access.workspaceId,
        threadId: cmd.threadId,
        uploaderUserId: userId,
        fileName: cmd.fileName,
        mimeType: cmd.mimeType,
        sizeBytes,
        dataBase64: cmd.dataBase64,
      })
      .returning({ id: schema.fileAttachments.id });
    const id = row!.id;
    // 축6: 무거운 다단 파서/OCR는 요청 스레드에서 돌리지 않는다. 먼저 pending
    // extraction row를 만들고(UI "분석 중" 표시), 실제 추출은 잡 워커에 위임.
    await this.db
      .insert(schema.documentExtractions)
      .values({
        workspaceId: access.workspaceId,
        threadId: cmd.threadId,
        attachmentId: id,
        status: 'processing',
        extractor: null,
        textContent: '',
        textChars: 0,
        qualityScore: 0,
        warnings: [],
      })
      .onConflictDoNothing({ target: schema.documentExtractions.attachmentId });
    await this.extractionWorker.enqueue({
      attachmentId: id,
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      fileName: cmd.fileName,
      mimeType: cmd.mimeType,
      uploaderUserId: userId,
    });
    return parseResponse(UploadAttachmentResponseSchema, { id });
  }

  @Get('threads/:threadId')
  async list(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    await this.requireThread(userId, threadId);
    const rows = await this.db
      .select({
        id: schema.fileAttachments.id,
        fileName: schema.fileAttachments.fileName,
        mimeType: schema.fileAttachments.mimeType,
        sizeBytes: schema.fileAttachments.sizeBytes,
        uploaderUserId: schema.fileAttachments.uploaderUserId,
        createdAt: schema.fileAttachments.createdAt,
        extractionStatus: schema.documentExtractions.status,
        extractionExtractor: schema.documentExtractions.extractor,
        extractionTextChars: schema.documentExtractions.textChars,
        extractionQualityScore: schema.documentExtractions.qualityScore,
        extractionWarnings: schema.documentExtractions.warnings,
      })
      .from(schema.fileAttachments)
      .leftJoin(schema.documentExtractions, eq(schema.documentExtractions.attachmentId, schema.fileAttachments.id))
      .where(and(
        eq(schema.fileAttachments.threadId, threadId),
        isNull(schema.fileAttachments.messageId),
        isNull(schema.fileAttachments.deletedAt),
      ))
      .orderBy(asc(schema.fileAttachments.createdAt));
    return parseResponse(ListAttachmentsResponseSchema, {
      attachments: rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        extraction: r.extractionStatus
          ? {
              status: r.extractionStatus as 'processing' | 'indexed' | 'skipped' | 'failed',
              extractor: r.extractionExtractor,
              textChars: r.extractionTextChars ?? 0,
              qualityScore: r.extractionQualityScore ?? 0,
              warnings: r.extractionWarnings ?? [],
            }
          : null,
        uploaderUserId: r.uploaderUserId,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }

  /** Delete a draft/message attachment. Soft-delete keeps auditability while removing it from UI/search/download. */
  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const [row] = await this.db
      .select({ threadId: schema.fileAttachments.threadId })
      .from(schema.fileAttachments)
      .where(and(eq(schema.fileAttachments.id, id), isNull(schema.fileAttachments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'attachment not found' });
    await this.requireThread(userId, row.threadId);
    await this.db
      .update(schema.fileAttachments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.fileAttachments.id, id), isNull(schema.fileAttachments.deletedAt)));
    return parseResponse(OkResponseSchema, { ok: true });
  }

  /** 축3: 파일 뷰어용 추출 텍스트. HWP/HWPX/PDF 원문을 인라인 뷰어에서 표시. */
  @Get(':id/extraction')
  async extraction(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const [row] = await this.db
      .select({
        threadId: schema.fileAttachments.threadId,
        fileName: schema.fileAttachments.fileName,
        mimeType: schema.fileAttachments.mimeType,
        status: schema.documentExtractions.status,
        extractor: schema.documentExtractions.extractor,
        textContent: schema.documentExtractions.textContent,
        textChars: schema.documentExtractions.textChars,
        qualityScore: schema.documentExtractions.qualityScore,
        warnings: schema.documentExtractions.warnings,
      })
      .from(schema.fileAttachments)
      .leftJoin(schema.documentExtractions, eq(schema.documentExtractions.attachmentId, schema.fileAttachments.id))
      .where(and(eq(schema.fileAttachments.id, id), isNull(schema.fileAttachments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'attachment not found' });
    await this.requireThread(userId, row.threadId);
    return parseResponse(AttachmentExtractionResponseSchema, {
      attachmentId: id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      status: (row.status as 'processing' | 'indexed' | 'skipped' | 'failed' | null) ?? null,
      extractor: row.extractor ?? null,
      textContent: row.textContent ?? '',
      textChars: row.textChars ?? 0,
      qualityScore: row.qualityScore ?? 0,
      warnings: row.warnings ?? [],
    });
  }

  /** Binary download. Membership enforced via the owning thread. */
  @Get(':id/content')
  async download(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const userId = requireAuthUserId(req);
    const [row] = await this.db
      .select({
        threadId: schema.fileAttachments.threadId,
        fileName: schema.fileAttachments.fileName,
        mimeType: schema.fileAttachments.mimeType,
        dataBase64: schema.fileAttachments.dataBase64,
      })
      .from(schema.fileAttachments)
      .where(and(eq(schema.fileAttachments.id, id), isNull(schema.fileAttachments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'attachment not found' });
    await this.requireThread(userId, row.threadId);

    const buf = Buffer.from(row.dataBase64, 'base64');
    res.setHeader('content-type', row.mimeType);
    res.setHeader('content-length', String(buf.length));
    res.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
    );
    // Defense-in-depth: never render user uploads inline in the app origin.
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(buf);
  }

  private async requireThread(userId: string, threadId: string): Promise<{ workspaceId: string }> {
    const access = await this.chatAccess.canReadThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });
    return { workspaceId: access.workspaceId };
  }
}
