import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type ChatStreamAccess =
  | { status: 'allowed'; workspaceId: string; projectId: string }
  | { status: 'not_found' }
  | { status: 'forbidden' };

@Injectable()
export class ChatStreamUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async canReadThread(userId: string, threadId: string): Promise<ChatStreamAccess> {
    // Resolve the thread's project (threads → topics → channels) so callers can
    // scope Hermes memory per project (#3). All parent levels must be active.
    const [thread] = await this.db
      .select({
        id: schema.threads.id,
        workspaceId: schema.threads.workspaceId,
        projectId: schema.channels.projectId,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .where(and(eq(schema.threads.id, threadId), eq(schema.threads.status, 'active')))
      .limit(1);
    if (!thread) return { status: 'not_found' };

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
    return membership
      ? { status: 'allowed', workspaceId: thread.workspaceId, projectId: thread.projectId }
      : { status: 'forbidden' };
  }

}
