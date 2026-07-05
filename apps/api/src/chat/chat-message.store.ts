import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ListMessagesResponse } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type FinishState = 'complete' | 'cancelled' | 'error';

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
  }): Promise<void> {
    await this.db.insert(schema.chatMessages).values({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: 'user',
      authorUserId: input.authorUserId,
      content: input.content,
      finishState: 'complete',
    });
  }

  async saveAssistantMessage(input: {
    workspaceId: string;
    threadId: string;
    content: string;
    runId: string | null;
    finishState: FinishState;
  }): Promise<void> {
    // Persist even partial/cancelled output — an empty error row still tells
    // the user "this turn failed" after a refresh.
    await this.db.insert(schema.chatMessages).values({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: 'assistant',
      authorUserId: null,
      content: input.content,
      runId: input.runId,
      finishState: input.finishState,
    });
  }

  async listMessages(threadId: string): Promise<ListMessagesResponse> {
    const rows = await this.db
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
      .leftJoin(schema.users, eq(schema.chatMessages.authorUserId, schema.users.id))
      .where(and(eq(schema.chatMessages.threadId, threadId), isNull(schema.chatMessages.deletedAt)))
      .orderBy(asc(schema.chatMessages.createdAt));

    return {
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        authorUserId: r.authorUserId,
        authorName: r.authorName,
        runId: r.runId,
        finishState: (r.finishState as FinishState) ?? 'complete',
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
