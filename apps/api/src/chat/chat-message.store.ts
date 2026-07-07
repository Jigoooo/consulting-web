import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import type { ChatMessage, ChatMessageAttachment, ListMessagesPageRequest, ListMessagesPageResponse, ListMessagesResponse, SearchMessagesResponse } from '@consulting/contracts';
import { hangulMatch, highlightRanges, isChosungQuery } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type FinishState = 'complete' | 'cancelled' | 'error';

type DbMessageRow = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  runId: string | null;
  finishState: string;
  createdAt: Date;
};

type MessageRow = ChatMessage & { createdAtDate: Date };

/**
 * Persistence for chat transcripts (N-1). The stream controller writes here:
 * user row before proxying, assistant row after the stream settles (done /
 * client abort / upstream error) so a refresh always reproduces the dialogue.
 */
@Injectable()
export class ChatMessageStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async saveUserMessage(input: {
    workspaceId: string;
    threadId: string;
    authorUserId: string;
    content: string;
  }): Promise<string> {
    const [row] = await this.db.insert(schema.chatMessages).values({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: 'user',
      authorUserId: input.authorUserId,
      content: input.content,
      finishState: 'complete',
    }).returning({ id: schema.chatMessages.id });
    return row!.id;
  }

  async bindAttachmentsToMessage(input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    attachmentIds: string[];
    uploaderUserId: string;
  }): Promise<void> {
    if (input.attachmentIds.length === 0) return;
    await this.db
      .update(schema.fileAttachments)
      .set({ messageId: input.messageId })
      .where(and(
        eq(schema.fileAttachments.workspaceId, input.workspaceId),
        eq(schema.fileAttachments.threadId, input.threadId),
        eq(schema.fileAttachments.uploaderUserId, input.uploaderUserId),
        isNull(schema.fileAttachments.messageId),
        isNull(schema.fileAttachments.deletedAt),
        inArray(schema.fileAttachments.id, input.attachmentIds),
      ));
  }

  async saveAssistantMessage(input: {
    workspaceId: string;
    threadId: string;
    content: string;
    runId: string | null;
    finishState: FinishState;
  }): Promise<string> {
    // Persist even partial/cancelled output — an empty error row still tells
    // the user "this turn failed" after a refresh.
    const [row] = await this.db.insert(schema.chatMessages).values({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: 'assistant',
      authorUserId: null,
      content: input.content,
      runId: input.runId,
      finishState: input.finishState,
    }).returning({ id: schema.chatMessages.id });
    return row!.id;
  }

  async listMessages(threadId: string): Promise<ListMessagesResponse> {
    const rows = await this.selectBase()
      .where(this.visibleThread(threadId))
      .orderBy(asc(schema.chatMessages.createdAt), asc(schema.chatMessages.id));

    return { messages: await this.attachmentsForMessages(rows.map((r) => this.toMessage(r))) };
  }

  async listMessagesPage(threadId: string, input: ListMessagesPageRequest): Promise<ListMessagesPageResponse> {
    const limit = input.limit ?? 50;
    if (input.around) return this.listAround(threadId, input.around, limit);
    if (input.before) return this.listBefore(threadId, input.before, limit);
    if (input.after) return this.listAfter(threadId, input.after, limit);
    return this.listLatest(threadId, limit);
  }

  async searchMessages(threadId: string, query: string, limit = 20): Promise<SearchMessagesResponse> {
    const q = query.trim();
    if (!q) return { results: [], messages: [], files: [], evidence: [] };
    // F2: hangul-aware match (초성/합성/띄어쓰기무시) done in JS over the thread's
    // messages. Pull a bounded recent slice (thread-scoped, capped) and filter.
    const rows = await this.selectBase()
      .where(this.visibleThread(threadId))
      .orderBy(desc(schema.chatMessages.createdAt), desc(schema.chatMessages.id))
      .limit(2000);
    const cap = Math.min(Math.max(limit, 1), 100);
    const messages: SearchMessagesResponse['messages'] = [];
    const isCho = isChosungQuery(q);
    for (const row of rows) {
      if (!hangulMatch(row.content, q)) continue;
      const ranges = highlightRanges(row.content, q);
      const matchKind = ranges.length > 0 ? 'text' : isCho ? 'chosung' : 'jamo';
      messages.push({
        id: row.id,
        role: row.role,
        snippet: this.snippet(row.content, q, ranges[0]?.[0] ?? -1),
        createdAt: row.createdAt.toISOString(),
        matchKind,
      });
      if (messages.length >= cap) break;
    }
    const [files, evidence] = await Promise.all([
      this.searchFiles(threadId, q, cap),
      this.searchEvidence(threadId, q, cap),
    ]);
    return { results: messages, messages, files, evidence };
  }

  private async searchFiles(threadId: string, q: string, cap: number): Promise<SearchMessagesResponse['files']> {
    const rows = await this.db
      .select({
        id: schema.fileAttachments.id,
        fileName: schema.fileAttachments.fileName,
        mimeType: schema.fileAttachments.mimeType,
        messageId: schema.fileAttachments.messageId,
        createdAt: schema.fileAttachments.createdAt,
        status: schema.documentExtractions.status,
        textContent: schema.documentExtractions.textContent,
      })
      .from(schema.fileAttachments)
      .leftJoin(schema.documentExtractions, eq(schema.documentExtractions.attachmentId, schema.fileAttachments.id))
      .where(and(eq(schema.fileAttachments.threadId, threadId), isNull(schema.fileAttachments.deletedAt)))
      .orderBy(desc(schema.fileAttachments.createdAt), desc(schema.fileAttachments.id))
      .limit(2000);
    const results: SearchMessagesResponse['files'] = [];
    for (const row of rows) {
      const haystack = `${row.fileName}\n${row.textContent ?? ''}`;
      if (!hangulMatch(haystack, q)) continue;
      const ranges = highlightRanges(row.textContent ?? '', q);
      results.push({
        id: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        snippet: ranges.length > 0 ? this.snippet(row.textContent ?? '', q, ranges[0]?.[0] ?? -1) : row.fileName,
        messageId: row.messageId,
        status: row.status as 'processing' | 'indexed' | 'skipped' | 'failed' | null,
        createdAt: row.createdAt.toISOString(),
      });
      if (results.length >= cap) break;
    }
    return results;
  }

  private async searchEvidence(threadId: string, q: string, cap: number): Promise<SearchMessagesResponse['evidence']> {
    const rows = await this.db
      .select({
        id: schema.evidenceItems.id,
        sourceType: schema.evidenceItems.sourceType,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        url: schema.evidenceItems.url,
        messageId: schema.evidenceItems.messageId,
        runId: schema.evidenceItems.runId,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .where(and(eq(schema.evidenceItems.threadId, threadId), isNull(schema.evidenceItems.deletedAt)))
      .orderBy(desc(schema.evidenceItems.createdAt), desc(schema.evidenceItems.id))
      .limit(2000);
    const results: SearchMessagesResponse['evidence'] = [];
    for (const row of rows) {
      const haystack = `${row.ref}\n${row.excerpt}`;
      if (!hangulMatch(haystack, q)) continue;
      const ranges = highlightRanges(row.excerpt, q);
      results.push({
        id: row.id,
        sourceType: row.sourceType,
        ref: row.ref,
        snippet: ranges.length > 0 ? this.snippet(row.excerpt, q, ranges[0]?.[0] ?? -1) : row.excerpt.slice(0, 140),
        url: row.url,
        messageId: row.messageId,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
      });
      if (results.length >= cap) break;
    }
    return results;
  }

  private async listLatest(threadId: string, limit: number): Promise<ListMessagesPageResponse> {
    const rows = await this.selectBase()
      .where(this.visibleThread(threadId))
      .orderBy(desc(schema.chatMessages.createdAt), desc(schema.chatMessages.id))
      .limit(limit + 1);
    const hasOlder = rows.length > limit;
    return this.page(rows.slice(0, limit).reverse(), hasOlder, false);
  }

  private async listBefore(threadId: string, beforeId: string, limit: number): Promise<ListMessagesPageResponse> {
    const cursor = await this.cursor(threadId, beforeId);
    if (!cursor) return this.emptyPage();
    const rows = await this.selectBase()
      .where(and(
        this.visibleThread(threadId),
        or(
          lt(schema.chatMessages.createdAt, cursor.createdAtDate),
          and(eq(schema.chatMessages.createdAt, cursor.createdAtDate), lt(schema.chatMessages.id, cursor.id)),
        ),
      ))
      .orderBy(desc(schema.chatMessages.createdAt), desc(schema.chatMessages.id))
      .limit(limit + 1);
    const hasOlder = rows.length > limit;
    return this.page(rows.slice(0, limit).reverse(), hasOlder, true);
  }

  private async listAfter(threadId: string, afterId: string, limit: number): Promise<ListMessagesPageResponse> {
    const cursor = await this.cursor(threadId, afterId);
    if (!cursor) return this.emptyPage();
    const rows = await this.selectBase()
      .where(and(
        this.visibleThread(threadId),
        or(
          gt(schema.chatMessages.createdAt, cursor.createdAtDate),
          and(eq(schema.chatMessages.createdAt, cursor.createdAtDate), gt(schema.chatMessages.id, cursor.id)),
        ),
      ))
      .orderBy(asc(schema.chatMessages.createdAt), asc(schema.chatMessages.id))
      .limit(limit + 1);
    const hasNewer = rows.length > limit;
    return this.page(rows.slice(0, limit), true, hasNewer);
  }

  private async listAround(threadId: string, aroundId: string, limit: number): Promise<ListMessagesPageResponse> {
    const anchor = await this.cursor(threadId, aroundId);
    if (!anchor) return this.emptyPage();
    const beforeCount = Math.floor((limit - 1) / 2);
    const afterCount = Math.max(0, limit - 1 - beforeCount);
    const olderRows = beforeCount > 0
      ? await this.selectBase()
        .where(and(
          this.visibleThread(threadId),
          or(
            lt(schema.chatMessages.createdAt, anchor.createdAtDate),
            and(eq(schema.chatMessages.createdAt, anchor.createdAtDate), lt(schema.chatMessages.id, anchor.id)),
          ),
        ))
        .orderBy(desc(schema.chatMessages.createdAt), desc(schema.chatMessages.id))
        .limit(beforeCount + 1)
      : [];
    const newerRows = afterCount > 0
      ? await this.selectBase()
        .where(and(
          this.visibleThread(threadId),
          or(
            gt(schema.chatMessages.createdAt, anchor.createdAtDate),
            and(eq(schema.chatMessages.createdAt, anchor.createdAtDate), gt(schema.chatMessages.id, anchor.id)),
          ),
        ))
        .orderBy(asc(schema.chatMessages.createdAt), asc(schema.chatMessages.id))
        .limit(afterCount + 1)
      : [];
    const page = await this.page(
      [...olderRows.slice(0, beforeCount).reverse(), anchor, ...newerRows.slice(0, afterCount)],
      olderRows.length > beforeCount,
      newerRows.length > afterCount,
    );
    return { ...page, anchorMessageId: anchor.id };
  }

  private async cursor(threadId: string, messageId: string): Promise<MessageRow | null> {
    const [row] = await this.selectBase()
      .where(and(this.visibleThread(threadId), eq(schema.chatMessages.id, messageId)))
      .limit(1);
    return row ? this.toMessageRow(row) : null;
  }

  private selectBase() {
    return this.db
      .select({
        id: schema.chatMessages.id,
        role: schema.chatMessages.role,
        content: schema.chatMessages.content,
        authorUserId: schema.chatMessages.authorUserId,
        authorName: schema.users.displayName,
        runId: schema.chatMessages.runId,
        finishState: schema.chatMessages.finishState,
        createdAt: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .leftJoin(schema.users, eq(schema.chatMessages.authorUserId, schema.users.id));
  }

  private visibleThread(threadId: string) {
    return and(eq(schema.chatMessages.threadId, threadId), isNull(schema.chatMessages.deletedAt));
  }

  private async page(rows: ReadonlyArray<DbMessageRow | MessageRow>, hasOlder: boolean, hasNewer: boolean): Promise<ListMessagesPageResponse> {
    const messages = await this.attachmentsForMessages(rows.map((r) => ('createdAtDate' in r ? this.stripDate(r) : this.toMessage(r))));
    return {
      messages,
      hasOlder,
      hasNewer,
      olderCursor: messages[0]?.id ?? null,
      newerCursor: messages.at(-1)?.id ?? null,
    };
  }

  private emptyPage(): ListMessagesPageResponse {
    return { messages: [], hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null };
  }

  private toMessageRow(r: DbMessageRow): MessageRow {
    return { ...this.toMessage(r), createdAtDate: r.createdAt };
  }

  private stripDate(row: MessageRow): ChatMessage {
    const { createdAtDate: _createdAtDate, ...message } = row;
    return message;
  }

  private toMessage(r: DbMessageRow): ChatMessage {
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      authorUserId: r.authorUserId,
      authorName: r.authorName,
      runId: r.runId,
      finishState: (r.finishState as FinishState) ?? 'complete',
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async attachmentsForMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const messageIds = messages.map((message) => message.id);
    if (messageIds.length === 0) return messages;
    const rows = await this.db
      .select({
        id: schema.fileAttachments.id,
        messageId: schema.fileAttachments.messageId,
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
      .where(and(inArray(schema.fileAttachments.messageId, messageIds), isNull(schema.fileAttachments.deletedAt)))
      .orderBy(asc(schema.fileAttachments.createdAt), asc(schema.fileAttachments.id));
    const byMessage = new Map<string, ChatMessageAttachment[]>();
    for (const row of rows) {
      if (!row.messageId) continue;
      const attachment: ChatMessageAttachment = {
        id: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        extraction: row.extractionStatus
          ? {
              status: row.extractionStatus as 'processing' | 'indexed' | 'skipped' | 'failed',
              extractor: row.extractionExtractor,
              textChars: row.extractionTextChars ?? 0,
              qualityScore: row.extractionQualityScore ?? 0,
              warnings: row.extractionWarnings ?? [],
            }
          : null,
        uploaderUserId: row.uploaderUserId,
        createdAt: row.createdAt.toISOString(),
      };
      byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), attachment]);
    }
    return messages.map((message) => {
      const attachments = byMessage.get(message.id);
      return attachments && attachments.length > 0 ? { ...message, attachments } : message;
    });
  }

  private snippet(content: string, query: string, hintIndex = -1): string {
    // Prefer the highlight-range start (F2); fall back to a plain substring probe.
    let index = hintIndex;
    if (index < 0) {
      index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    }
    if (index < 0) return content.slice(0, 140);
    const start = Math.max(0, index - 48);
    const end = Math.min(content.length, index + query.length + 92);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < content.length ? '…' : '';
    return `${prefix}${content.slice(start, end)}${suffix}`;
  }
}
