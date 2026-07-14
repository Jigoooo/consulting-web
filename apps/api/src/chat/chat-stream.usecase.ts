import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { SpaceAccessService } from '../spaces/space-access.service.js';
import type { Permission } from '../permissions/permission.types.js';

export type ChatStreamAccess =
  | { status: 'allowed'; workspaceId: string; projectId: string }
  | { status: 'not_found' }
  | { status: 'forbidden' };

@Injectable()
export class ChatStreamUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async canReadThread(userId: string, threadId: string): Promise<ChatStreamAccess> {
    return this.canAccessThread(userId, threadId, 'message.read');
  }

  async canSendThread(userId: string, threadId: string): Promise<ChatStreamAccess> {
    return this.canAccessThread(userId, threadId, 'message.send');
  }

  private async canAccessThread(userId: string, threadId: string, permission: Permission): Promise<ChatStreamAccess> {
    // Resolve the thread's project (threads → topics → channels) so callers can
    // scope Hermes memory per project (#3). All parent levels must be active.
    const [thread] = await this.db
      .select({
        id: schema.threads.id,
        workspaceId: schema.threads.workspaceId,
        projectId: schema.channels.projectId,
      })
      .from(schema.threads)
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
      .where(and(
        eq(schema.threads.id, threadId),
        eq(schema.threads.status, 'active'),
        eq(schema.topics.status, 'active'),
        eq(schema.channels.status, 'active'),
        eq(schema.projects.status, 'active'),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
        isNull(schema.workspaces.deletedAt),
      ))
      .limit(1);
    if (!thread) return { status: 'not_found' };

    const access = await new SpaceAccessService(this.db).threadPermission(userId, threadId, permission);
    return access.allowed
      ? { status: 'allowed', workspaceId: thread.workspaceId, projectId: thread.projectId }
      : { status: 'forbidden' };
  }

}
