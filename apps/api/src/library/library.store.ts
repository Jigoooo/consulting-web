import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, ilike, isNull, or, type SQL } from 'drizzle-orm';
import type { ListLibrarySourcesResponse, LibrarySourceItem, LibrarySourceType } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const PAGE_SIZE = 40;
const SNIPPET_CHARS = 280;

export interface LibraryQuery {
  workspaceId: string;
  projectId?: string | undefined;
  type?: LibrarySourceType | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * 자료실 집계 store(축4). evidence_items + file_attachments(+extraction) +
 * artifacts 를 워크스페이스/프로젝트 단위로 모아 통합 목록으로 반환.
 *
 * 원칙:
 *  - F9: soft-delete는 자식 자료로 캐스케이드하지 않으므로 부모 계층
 *    (thread→topic→channel→project) deletedAt 을 전부 가드해 유령자료 차단.
 *  - 대용량 컬럼(data_base64, text_content) 은 목록 SELECT에서 제외 —
 *    검색은 pg-side ILIKE, 스니펫은 짧은 excerpt/제목만.
 *  - 세 소스를 각각 조회 후 앱에서 병합·정렬(createdAt desc)·커서 페이지.
 */
@Injectable()
export class LibraryStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(query: LibraryQuery): Promise<ListLibrarySourcesResponse> {
    const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), 100);
    const wantEvidence = !query.type || ['gbrain', 'web', 'file', 'tool', 'manual'].includes(query.type);
    const wantAttachment = !query.type || query.type === 'document';
    const wantArtifact = !query.type || query.type === 'artifact';

    const [evidence, attachments, artifacts] = await Promise.all([
      wantEvidence ? this.evidence(query) : Promise.resolve([]),
      wantAttachment ? this.attachments(query) : Promise.resolve([]),
      wantArtifact ? this.artifacts(query) : Promise.resolve([]),
    ]);

    const merged = [...evidence, ...attachments, ...artifacts].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    // 커서 = createdAt|id (안정 정렬). cursor 이후 항목만.
    const start = query.cursor ? merged.findIndex((s) => `${s.createdAt}|${s.id}` === query.cursor) + 1 : 0;
    const page = merged.slice(start, start + limit);
    const nextCursor = start + limit < merged.length ? `${page[page.length - 1]!.createdAt}|${page[page.length - 1]!.id}` : null;
    return { sources: page, nextCursor };
  }

  private snippet(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > SNIPPET_CHARS ? clean.slice(0, SNIPPET_CHARS) + '…' : clean;
  }

  private async evidence(q: LibraryQuery): Promise<LibrarySourceItem[]> {
    const conds: SQL[] = [
      eq(schema.channels.workspaceId, q.workspaceId),
      eq(schema.threads.status, 'active'),
      eq(schema.topics.status, 'active'),
      eq(schema.channels.status, 'active'),
      eq(schema.projects.status, 'active'),
      isNull(schema.evidenceItems.deletedAt),
      isNull(schema.threads.deletedAt),
      isNull(schema.topics.deletedAt),
      isNull(schema.channels.deletedAt),
      isNull(schema.projects.deletedAt),
      isNull(schema.workspaces.deletedAt),
    ];
    if (q.projectId) conds.push(eq(schema.channels.projectId, q.projectId));
    if (q.type && ['gbrain', 'web', 'file', 'tool', 'manual'].includes(q.type)) {
      conds.push(eq(schema.evidenceItems.sourceType, q.type as 'gbrain' | 'web' | 'file' | 'tool' | 'manual'));
    }
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      const search = or(ilike(schema.evidenceItems.ref, like), ilike(schema.evidenceItems.excerpt, like));
      if (search) conds.push(search);
    }
    const rows = await this.db
      .select({
        id: schema.evidenceItems.id,
        sourceType: schema.evidenceItems.sourceType,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        url: schema.evidenceItems.url,
        messageId: schema.evidenceItems.messageId,
        qualityScore: schema.evidenceItems.qualityScore,
        threadId: schema.evidenceItems.threadId,
        projectId: schema.channels.projectId,
        channelName: schema.channels.name,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .innerJoin(schema.threads, and(
        eq(schema.evidenceItems.threadId, schema.threads.id),
        eq(schema.evidenceItems.workspaceId, schema.threads.workspaceId),
      ))
      .innerJoin(schema.topics, and(
        eq(schema.threads.topicId, schema.topics.id),
        eq(schema.threads.workspaceId, schema.topics.workspaceId),
      ))
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(...conds))
      .orderBy(desc(schema.evidenceItems.createdAt))
      .limit(200);

    return rows.map((r) => ({
      kind: 'evidence' as const,
      id: r.id,
      title: r.ref,
      sourceType: r.sourceType,
      projectId: r.projectId,
      channelName: r.channelName,
      threadId: r.threadId,
      snippet: this.snippet(r.excerpt),
      url: r.url,
      mimeType: null,
      sizeBytes: null,
      messageId: r.messageId,
      status: null,
      qualityScore: r.qualityScore,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async attachments(q: LibraryQuery): Promise<LibrarySourceItem[]> {
    const conds: SQL[] = [
      eq(schema.channels.workspaceId, q.workspaceId),
      eq(schema.threads.status, 'active'),
      eq(schema.topics.status, 'active'),
      eq(schema.channels.status, 'active'),
      eq(schema.projects.status, 'active'),
      isNull(schema.fileAttachments.deletedAt),
      isNull(schema.threads.deletedAt),
      isNull(schema.topics.deletedAt),
      isNull(schema.channels.deletedAt),
      isNull(schema.projects.deletedAt),
      isNull(schema.workspaces.deletedAt),
    ];
    if (q.projectId) conds.push(eq(schema.channels.projectId, q.projectId));
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      // 문서명 + 추출 원문(text_content 200K)까지 pg-side ILIKE.
      const search = or(ilike(schema.fileAttachments.fileName, like), ilike(schema.documentExtractions.textContent, like));
      if (search) conds.push(search);
    }
    const rows = await this.db
      .select({
        id: schema.fileAttachments.id,
        fileName: schema.fileAttachments.fileName,
        mimeType: schema.fileAttachments.mimeType,
        sizeBytes: schema.fileAttachments.sizeBytes,
        threadId: schema.fileAttachments.threadId,
        messageId: schema.fileAttachments.messageId,
        projectId: schema.channels.projectId,
        channelName: schema.channels.name,
        createdAt: schema.fileAttachments.createdAt,
        status: schema.documentExtractions.status,
        qualityScore: schema.documentExtractions.qualityScore,
        // 스니펫만 — text_content 전체를 목록에 싣지 않되, 앞부분만 substring.
        textContent: schema.documentExtractions.textContent,
      })
      .from(schema.fileAttachments)
      .innerJoin(schema.threads, and(
        eq(schema.fileAttachments.threadId, schema.threads.id),
        eq(schema.fileAttachments.workspaceId, schema.threads.workspaceId),
      ))
      .innerJoin(schema.topics, and(
        eq(schema.threads.topicId, schema.topics.id),
        eq(schema.threads.workspaceId, schema.topics.workspaceId),
      ))
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .leftJoin(schema.documentExtractions, eq(schema.documentExtractions.attachmentId, schema.fileAttachments.id))
      .where(and(...conds))
      .orderBy(desc(schema.fileAttachments.createdAt))
      .limit(200);

    return rows.map((r) => ({
      kind: 'attachment' as const,
      id: r.id,
      title: r.fileName,
      sourceType: 'document' as const,
      projectId: r.projectId,
      channelName: r.channelName,
      threadId: r.threadId,
      snippet: this.snippet(r.textContent ?? ''),
      url: null,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      messageId: r.messageId,
      status: r.status ?? null,
      qualityScore: r.qualityScore ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async artifacts(q: LibraryQuery): Promise<LibrarySourceItem[]> {
    const conds: SQL[] = [
      eq(schema.artifacts.workspaceId, q.workspaceId),
      eq(schema.projects.status, 'active'),
      isNull(schema.artifacts.deletedAt),
      isNull(schema.projects.deletedAt),
      isNull(schema.workspaces.deletedAt),
    ];
    if (q.projectId) conds.push(eq(schema.artifacts.projectId, q.projectId));
    if (q.q) conds.push(ilike(schema.artifacts.title, `%${escapeLike(q.q)}%`));

    const rows = await this.db
      .select({
        id: schema.artifacts.id,
        title: schema.artifacts.title,
        headVersion: schema.artifacts.headVersion,
        projectId: schema.artifacts.projectId,
        channelName: schema.projects.name,
        createdAt: schema.artifacts.updatedAt,
      })
      .from(schema.artifacts)
      .innerJoin(schema.projects, and(
        eq(schema.artifacts.projectId, schema.projects.id),
        eq(schema.artifacts.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(...conds))
      .orderBy(desc(schema.artifacts.updatedAt))
      .limit(200);

    return rows.map((r) => ({
      kind: 'artifact' as const,
      id: r.id,
      title: r.title,
      sourceType: 'artifact' as const,
      projectId: r.projectId,
      channelName: r.channelName,
      threadId: null,
      snippet: `버전 v${r.headVersion}`,
      url: null,
      mimeType: null,
      sizeBytes: null,
      messageId: null,
      status: null,
      qualityScore: null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

/** ILIKE 와일드카드(%_\)를 리터럴로 이스케이프. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
