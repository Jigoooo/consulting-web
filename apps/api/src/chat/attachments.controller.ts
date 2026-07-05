import {
  BadRequestException,
  Body,
  Controller,
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
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/'];

/** Phase 2-D G-3 — chat attachments (base64 in pg; 10MB cap; mime allowlist). */
@Controller('attachments')
@UseGuards(AccessTokenGuard)
export class AttachmentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ChatStreamUseCase) private readonly chatAccess: ChatStreamUseCase,
  ) {}

  @Post()
  async upload(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(UploadAttachmentRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThread(userId, cmd.threadId);

    if (!ALLOWED_MIME_PREFIXES.some((p) => cmd.mimeType.startsWith(p))) {
      throw new BadRequestException({ code: 'UNSUPPORTED_TYPE', message: '이미지, PDF, 텍스트 파일만 첨부할 수 있어요.' });
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
    return parseResponse(UploadAttachmentResponseSchema, { id: row!.id });
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
      })
      .from(schema.fileAttachments)
      .where(and(eq(schema.fileAttachments.threadId, threadId), isNull(schema.fileAttachments.deletedAt)))
      .orderBy(asc(schema.fileAttachments.createdAt));
    return parseResponse(ListAttachmentsResponseSchema, {
      attachments: rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        uploaderUserId: r.uploaderUserId,
        createdAt: r.createdAt.toISOString(),
      })),
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
