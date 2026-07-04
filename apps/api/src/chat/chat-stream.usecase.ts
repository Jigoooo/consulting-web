import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq } from 'drizzle-orm';
import type { ChatStreamEvent, ChatStreamRequest } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type ChatStreamAccess = 'allowed' | 'not_found' | 'forbidden';

@Injectable()
export class ChatStreamUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async canReadThread(userId: string, threadId: string): Promise<ChatStreamAccess> {
    const [thread] = await this.db
      .select({ id: schema.threads.id, workspaceId: schema.threads.workspaceId })
      .from(schema.threads)
      .where(and(eq(schema.threads.id, threadId), eq(schema.threads.status, 'active')))
      .limit(1);
    if (!thread) return 'not_found';

    const [membership] = await this.db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.workspaceId, thread.workspaceId),
        ),
      )
      .limit(1);
    return membership ? 'allowed' : 'forbidden';
  }

  mockEvents(cmd: ChatStreamRequest): ChatStreamEvent[] {
    const runId = randomUUID();
    return [
      { type: 'start', runId, threadId: cmd.threadId, ts: new Date().toISOString() },
      { type: 'delta', runId, text: `mock: ${cmd.message}` },
      { type: 'done', runId },
    ];
  }
}
